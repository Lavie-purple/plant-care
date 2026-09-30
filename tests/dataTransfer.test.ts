/**
 * 数据搬运测试。
 *
 * 核心验证：导出的数据能不能原样导回来。
 * 这是 local-first 的保命功能，往返丢失任何一条记录都是事故。
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import 'fake-indexeddb/auto';

import { Repository } from '../src/storage/repository.js';
import { setDatabaseName, STORES } from '../src/storage/indexeddb.js';
import { PlantCareService, fixedClock } from '../src/app/vertical-slice.js';
import { DataTransferService } from '../src/data/DataTransferService.js';
import { validateBundle, type ExportBundle } from '../src/data/exportBundle.js';

const CLOCK = fixedClock('2026-09-30T14:32:00+08:00');
let seq = 0;
const openRepos: Repository[] = [];

afterEach(() => {
  while (openRepos.length) openRepos.pop()?.close();
});

async function newRepo() {
  seq += 1;
  setDatabaseName(`xfer-${seq}`);
  const repo = new Repository();
  await repo.open();
  openRepos.push(repo);
  return repo;
}

async function seed() {
  const repo = await newRepo();
  const svc = new PlantCareService(repo, new (await import('../src/weather/mock.js')).MockWeatherProvider(), CLOCK);

  const a = await svc.addPlant({
    name: '龟背竹 A', species: '龟背竹', family: '天南星科',
    placement: '客厅', exposure: 'indoor_window', potDiameterCm: 18, tags: ['客厅绿植'],
  });
  await svc.setCareRule(a.id, 7, 10);
  const b = await svc.addPlant({ name: '薄荷', placement: '阳台', exposure: 'outdoor' });
  await svc.setCareRule(b.id, 3, 5);

  await svc.recordWatering(a.id, { date: '2026-09-19', time: '14:20' });
  await svc.recordWatering(a.id, { date: '2026-09-28', time: '14:20', amountMl: 300 });
  await svc.recordWatering(b.id, { date: '2026-09-29', time: '09:00' });
  await svc.confirm(a.id, 'rec-1', 'delay');
  await svc.confirm(b.id, 'rec-2', 'watered');

  await repo.put(STORES.plantEvents, {
    id: 'e1', plantId: a.id, type: 'PHOTO', date: '2026-09-18',
    title: '新叶展开', images: ['img-1'], metadata: {}, createdAt: '2026-09-18T10:00:00+08:00', version: 1,
  });

  return { repo, svc, a, b };
}

describe('往返：导出 → 校验 → 导回新库', () => {
  test('数据完整保留', async () => {
    const src = await seed();
    const transfer = new DataTransferService(src.repo, CLOCK);
    const bundle = await transfer.collect();

    // 新库
    const dstRepo = await newRepo();
    const dstTransfer = new DataTransferService(dstRepo, CLOCK);
    await dstTransfer.commitImport(JSON.parse(JSON.stringify(bundle)), 'replace');

    const plants = await dstRepo.allPlants();
    assert.equal(plants.length, 2);
    assert.deepEqual(
      plants.map((p) => p.name).sort(),
      ['龟背竹 A', '薄荷'].sort(),
    );

    const aId = plants.find((p) => p.name === '龟背竹 A')!.id;
    const history = await dstRepo.wateringHistory(aId);
    assert.equal(history.length, 2, '龟背竹 A 的 2 条浇水记录必须都在');
    assert.ok(history.some((h) => h.amountMl === 300), '用户手填的水量要保留');
  });

  test('养护规则与 userOverride 保留', async () => {
    const src = await seed();
    const bundle = await new DataTransferService(src.repo, CLOCK).collect();

    const dstRepo = await newRepo();
    await new DataTransferService(dstRepo, CLOCK).commitImport(
      JSON.parse(JSON.stringify(bundle)),
      'replace',
    );

    const plants = await dstRepo.allPlants();
    for (const p of plants) {
      const rule = await dstRepo.getCareRuleByPlant(p.id);
      assert.ok(rule, `${p.name} 的养护规则必须保留`);
      assert.equal(rule?.userOverride, true, 'userOverride 不得在往返中丢失');
    }
  });

  test('事件与照片引用保留（D-08）', async () => {
    const src = await seed();
    const bundle = await new DataTransferService(src.repo, CLOCK).collect();

    const dstRepo = await newRepo();
    await new DataTransferService(dstRepo, CLOCK).commitImport(
      JSON.parse(JSON.stringify(bundle)),
      'replace',
    );

    const plants = await dstRepo.allPlants();
    const aId = plants.find((p) => p.name === '龟背竹 A')!.id;
    const timeline = await dstRepo.growthTimeline(aId);
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0]?.type, 'PHOTO');
    assert.deepEqual(timeline[0]?.images, ['img-1'], '图片引用不能丢');
  });

  test('决定日志保留，闭环历史不断', async () => {
    const src = await seed();
    const bundle = await new DataTransferService(src.repo, CLOCK).collect();

    const dstRepo = await newRepo();
    await new DataTransferService(dstRepo, CLOCK).commitImport(
      JSON.parse(JSON.stringify(bundle)),
      'replace',
    );

    const plants = await dstRepo.allPlants();
    const aId = plants.find((p) => p.name === '龟背竹 A')!.id;
    const decisions = await dstRepo.decisionsFor(aId);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.action, 'delay');
  });

  test('往返两次结果稳定（幂等）', async () => {
    const src = await seed();
    const b1 = await new DataTransferService(src.repo, CLOCK).collect();

    const mid = await newRepo();
    await new DataTransferService(mid, CLOCK).commitImport(JSON.parse(JSON.stringify(b1)), 'replace');
    const b2 = await new DataTransferService(mid, CLOCK).collect();

    assert.deepEqual(b2.data.plants, b1.data.plants);
    assert.deepEqual(b2.data.wateringRecords, b1.data.wateringRecords);
  });
});

describe('导入拒绝：绝不半途写入', () => {
  test('未通过校验的数据拒绝写入', async () => {
    const dstRepo = await newRepo();
    const transfer = new DataTransferService(dstRepo, CLOCK);

    const bad = {
      schemaVersion: 1,
      exportedAt: '2026-09-30T00:00:00Z',
      app: { name: 'x', version: '0' },
      counts: {},
      data: {
        // 悬空引用：引用了不存在的植物
        plants: [],
        careRules: [],
        wateringRecords: [
          { id: 'w1', plantId: 'ghost', date: '2026-09-28', time: '14:00', method: '浇透', completionState: 'complete', entrySource: 'single' },
        ],
        plantEvents: [], weatherSnapshots: [], recommendations: [],
        pendingConflicts: [], decisionLogs: [], settings: [],
      },
    } as unknown as ExportBundle;

    await assert.rejects(() => transfer.commitImport(bad, 'replace'), /未通过校验/);
    // 库里必须还是空的
    assert.equal((await dstRepo.allPlants()).length, 0);
  });

  test('版本不匹配拒绝写入', async () => {
    const src = await seed();
    const bundle = JSON.parse(JSON.stringify(await new DataTransferService(src.repo, CLOCK).collect()));
    bundle.schemaVersion = 99;

    const dstRepo = await newRepo();
    await assert.rejects(
      () => new DataTransferService(dstRepo, CLOCK).commitImport(bundle, 'replace'),
      /未通过校验/,
    );
    assert.equal((await dstRepo.allPlants()).length, 0);
  });

  test('replace 会清空原有数据，merge 不会', async () => {
    const src = await seed();
    const bundle = JSON.parse(JSON.stringify(await new DataTransferService(src.repo, CLOCK).collect()));

    const dstRepo = await newRepo();
    const dstSvc = new PlantCareService(dstRepo, new (await import('../src/weather/mock.js')).MockWeatherProvider(), CLOCK);
    await dstSvc.addPlant({ name: '原有的花', placement: '卧室', exposure: 'indoor' });
    assert.equal((await dstRepo.allPlants()).length, 1);

    const transfer = new DataTransferService(dstRepo, CLOCK);
    await transfer.commitImport(bundle, 'merge');
    assert.equal((await dstRepo.allPlants()).length, 3, 'merge 后原有 1 盆 + 导入 2 盆');

    await transfer.commitImport(bundle, 'replace');
    assert.equal((await dstRepo.allPlants()).length, 2, 'replace 后只剩导入的 2 盆');
  });

  test('merge 时同 id 跳过并报告', async () => {
    const src = await seed();
    const bundle = JSON.parse(JSON.stringify(await new DataTransferService(src.repo, CLOCK).collect()));

    const dstRepo = await newRepo();
    const transfer = new DataTransferService(dstRepo, CLOCK);
    // 第一次是全新增
    const first = await transfer.commitImport(bundle, 'merge');
    assert.equal(first.skipped, 0);
    // 第二次全部重复
    const second = await transfer.commitImport(bundle, 'merge');
    assert.ok(second.skipped > 0, '重复导入必须报告跳过数');
    assert.equal((await dstRepo.allPlants()).length, 2, '重复导入不得产生副本');
  });
});

describe('导出内容自检', () => {
  test('导出的 bundle 能通过自己的校验', async () => {
    const src = await seed();
    const bundle = await new DataTransferService(src.repo, CLOCK).collect();
    const v = validateBundle(JSON.parse(JSON.stringify(bundle)));
    assert.equal(v.ok, true, '自己导出的数据必须能被自己校验通过');
  });

  test('counts 与实际条数一致', async () => {
    const src = await seed();
    const bundle = await new DataTransferService(src.repo, CLOCK).collect();
    assert.equal(bundle.counts.plants, 2);
    assert.equal(bundle.counts.careRules, 2);
    assert.equal(bundle.counts.plantEvents, 1);
    // 3 次显式 recordWatering，加 confirm(watered) 自动产生 1 条 = 4
    assert.equal(bundle.counts.wateringRecords, 4);
  });
});
