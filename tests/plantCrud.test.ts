/**
 * 修改与删除植物的测试。
 *
 * 删除的重点不是「植物没了」，而是「它的记录也没了」。
 * 留下孤儿记录会让统计里出现查不到主人的数据，
 * 界面上和数据库损坏表现一样，极难排查。
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

import { Repository } from '../src/storage/repository.js';
import { setDatabaseName, STORES } from '../src/storage/indexeddb.js';
import { PlantCareService, fixedClock } from '../src/app/vertical-slice.js';
import { MockWeatherProvider, SCENARIOS } from '../src/weather/mock.js';
import type { Plant } from '../src/domain/types.js';

const CLOCK = fixedClock('2026-09-30T14:32:00+08:00');
let seq = 0;
const openRepos: Repository[] = [];

afterEach(() => {
  while (openRepos.length) openRepos.pop()?.close();
});

async function setup() {
  seq += 1;
  setDatabaseName(`edit-${seq}`);
  const repo = new Repository();
  await repo.open();
  openRepos.push(repo);
  const svc = new PlantCareService(repo, new MockWeatherProvider(SCENARIOS.mild), CLOCK);
  return { svc, repo };
}

describe('改植物档案', () => {
  test('只改传入的字段，其余保持原样', async () => {
    const { svc } = await setup();
    const p = await svc.addPlant({
      name: '龟背竹 A',
      species: '龟背竹',
      family: '天南星科',
      placement: '客厅',
      exposure: 'indoor_window',
      potDiameterCm: 18,
    });

    const r = await svc.updatePlant(p.id, { name: '龟背竹 A（改名）' });
    assert.equal(r.name, '龟背竹 A（改名）');
    // 没传的必须原样保留，不能被清空
    assert.equal(r.species, '龟背竹');
    assert.equal(r.family, '天南星科');
    assert.equal(r.placement, '客厅');
    assert.equal(r.potDiameterCm, 18);
  });

  test('version 递增，走乐观锁', async () => {
    const { svc } = await setup();
    const p = await svc.addPlant({ name: 'A', placement: '客厅', exposure: 'indoor_window' });
    assert.equal(p.version, 1);
    const r = await svc.updatePlant(p.id, { placement: '阳台' });
    assert.equal(r.version, 2);
  });

  test('植物不存在时明确报错', async () => {
    const { svc } = await setup();
    await assert.rejects(() => svc.updatePlant('ghost', { name: 'x' }), /不存在/);
  });

  test('updatedAt 会更新', async () => {
    // 用会走动的时间：固定时钟下创建与修改会得到同一时刻，
    // 那不是 bug，是测试把时钟冻住了却期望时间前进。
    seq += 1;
    setDatabaseName(`edit-walk-${seq}`);
    const repo = new Repository();
    await repo.open();
    openRepos.push(repo);
    let t0 = Date.parse('2026-09-30T14:32:00+08:00');
    const svc = new PlantCareService(repo, new MockWeatherProvider(SCENARIOS.mild), {
      now: () => new Date((t0 += 1000)),
      localDate: () => '2026-09-30',
      localTime: () => '14:32',
    });

    const p = await svc.addPlant({ name: 'A', placement: '客厅', exposure: 'indoor_window' });
    const r = await svc.updatePlant(p.id, { name: 'B' });
    assert.notEqual(r.updatedAt, p.updatedAt);
  });
});

describe('删植物：必须连带清干净', () => {
  async function seedPlant() {
    const { svc, repo } = await setup();
    const p = await svc.addPlant({ name: '龟背竹 A', placement: '客厅', exposure: 'indoor_window' });
    await svc.setCareRule(p.id, 7, 10);
    await svc.recordWatering(p.id, { date: '2026-09-20', time: '14:00' });
    await svc.recordWatering(p.id, { date: '2026-09-28', time: '14:00' });
    await svc.addNote(p.id, '换了个位置');
    await svc.attachPhoto(p.id, 'img-1', '长高了');
    await svc.confirm(p.id, 'rec-1', 'delay');
    return { svc, repo, p };
  }

  test('植物本身被删除', async () => {
    const { svc, p } = await seedPlant();
    await svc.deletePlant(p.id);
    assert.equal(await svc.getPlant(p.id), undefined);
  });

  test('浇水记录不留孤儿', async () => {
    const { svc, repo, p } = await seedPlant();
    const before = await repo.getAll<{ plantId: string }>(STORES.wateringRecords);
    assert.equal(before.length, 2);

    await svc.deletePlant(p.id);
    const after = await repo.getAll<{ plantId: string }>(STORES.wateringRecords);
    assert.equal(after.length, 0, '留了孤儿浇水记录');
  });

  test('养护规则不留孤儿', async () => {
    const { svc, repo, p } = await seedPlant();
    await svc.deletePlant(p.id);
    assert.equal((await repo.getAll(STORES.careRules)).length, 0);
  });

  test('事件不留孤儿', async () => {
    const { svc, repo, p } = await seedPlant();
    const before = (await repo.getAll<{ plantId: string }>(STORES.plantEvents)).length;
    assert.ok(before >= 2, '应有备注与照片两条事件');
    await svc.deletePlant(p.id);
    assert.equal((await repo.getAll<{ plantId: string }>(STORES.plantEvents)).length, 0);
  });

  test('决定日志不留孤儿', async () => {
    const { svc, repo, p } = await seedPlant();
    await svc.deletePlant(p.id);
    assert.equal((await repo.getAll<{ plantId: string }>(STORES.decisionLogs)).length, 0);
  });

  test('不误删别人的数据', async () => {
    const { svc, p } = await seedPlant();
    const other = await svc.addPlant({ name: '薄荷', placement: '阳台', exposure: 'outdoor' });
    await svc.recordWatering(other.id, { date: '2026-09-29', time: '09:00' });

    await svc.deletePlant(p.id);

    assert.ok(await svc.getPlant(other.id), '同库里的另一盆不能被删');
    const remain = await svc.wateringHistory(other.id);
    assert.equal(remain.length, 1, '另一盆的浇水记录不能被删');
  });

  test('删完库不报错，能继续写新植物', async () => {
    const { svc, p } = await seedPlant();
    await svc.deletePlant(p.id);
    const fresh = await svc.addPlant({ name: '新买的', placement: '书房', exposure: 'indoor' });
    assert.ok(fresh.id);
    assert.ok(await svc.getPlant(fresh.id));
  });
});