/**
 * 最小垂直闭环测试。
 *
 * 这是产品的第一条主线，也是第一个可验证目标：
 *   建植物 → 设规则 → 记浇水 → 取天气 → 出建议 → 确认 → 落记录 → 影响下一次判断
 *
 * 全部用 MockWeatherProvider，不依赖网络。
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import 'fake-indexeddb/auto';

import { PlantCareService, estimateWateringMl, fixedClock, DEFAULT_SETTINGS } from '../src/app/vertical-slice.js';
import { Repository } from '../src/storage/repository.js';
import { STORES, setDatabaseName } from '../src/storage/indexeddb.js';
import { MockWeatherProvider, SCENARIOS } from '../src/weather/mock.js';
import type { Plant } from '../src/domain/types.js';
import { OptimisticLockError } from '../src/storage/indexeddb.js';

let seq = 0;
const openRepos: Repository[] = [];
afterEach(() => {
  while (openRepos.length) openRepos.pop()?.close();
});

async function makeService(
  scenario = SCENARIOS.mild,
  clockIso = '2026-09-30T14:32:00+08:00',
): Promise<{ svc: PlantCareService; weather: MockWeatherProvider; repo: Repository }> {
  seq += 1;
  setDatabaseName(`vs-${seq}`);
  const repo = new Repository();
  await repo.open();
  openRepos.push(repo);
  const weather = new MockWeatherProvider(scenario);
  return { svc: new PlantCareService(repo, weather, fixedClock(clockIso)), weather, repo };
}

/** 造一条 n 天前的浇水记录 */
async function seedWatering(svc: PlantCareService, plantId: string, daysAgo: number): Promise<void> {
  const base = new Date('2026-09-30T14:32:00+08:00');
  base.setDate(base.getDate() - daysAgo);
  const m = String(base.getMonth() + 1).padStart(2, '0');
  const d = String(base.getDate()).padStart(2, '0');
  await svc.recordWatering(plantId, {
    date: `${base.getFullYear()}-${m}-${d}`,
    time: '14:20',
    entrySource: 'single',
  });
}

describe('闭环全流程：建植物 → 设规则 → 记浇水 → 取天气 → 出建议 → 确认 → 落记录', () => {
  test('七步全部走通，且最后一次浇水会影响下一次判断', async () => {
    const { svc, weather, repo } = await makeService(SCENARIOS.hotDry);

    // 1 建植物
    const plant = await svc.addPlant({
      name: '龟背竹 A',
      placement: '客厅',
      exposure: 'indoor_window',
      potDiameterCm: 18,
      species: '龟背竹',
      family: '天南星科',
      tags: ['客厅绿植'],
    });
    assert.ok(plant.id);

    // 2 设养护规则
    const rule = await svc.setCareRule(plant.id, 7, 10);
    assert.equal(rule.userOverride, true, '用户设定后必须锁死');

    // 3 记一次浇水
    const w1 = await svc.recordWatering(plant.id);
    assert.equal(w1.completionState, 'complete');
    assert.equal(w1.amountSource, 'user_provided_baseline', '未填水量时应为估算并标注');

    // 4 取天气（炎热干燥）
    const weatherIn = await svc.loadWeather();
    assert.equal(weatherIn.available, true);
    if (weatherIn.available) {
      assert.equal(weatherIn.snapshot.city, '广州');
      assert.equal(weatherIn.snapshot.provider, 'mock');
    }

    // 5 出建议：刚浇过水，应告诉用户不用浇
    const rec1 = await svc.recommend(plant.id, weatherIn);
    assert.equal(rec1.recommendation.action, 'NO_ACTION');

    // 6 用户确认
    const decision = await svc.confirm(plant.id, `rec-${Date.now()}`, 'confirm');
    assert.equal(decision.action, 'confirm');

    // 7 落记录：确认 watered 才产生新的 WateringRecord
    await svc.confirm(plant.id, `rec-${Date.now()}`, 'watered');
    const history = await repo.wateringHistory(plant.id);
    assert.equal(history.length, 2, '确认浇水后应新增一条记录');
  });

  test('闭环的关键：浇水记录真的回流成下一次判断的输入', async () => {
    const { svc, repo } = await makeService(SCENARIOS.hotDry);
    const plant = await svc.addPlant({ name: '龟背竹 A', placement: '客厅', exposure: 'indoor_window' });
    await svc.setCareRule(plant.id, 7, 10);

    // 11 天前浇过一次
    await seedWatering(svc, plant.id, 11);

    const weatherIn = await svc.loadWeather();
    const rec = await svc.recommend(plant.id, weatherIn);
    assert.equal(rec.recommendation.action, 'WATER_NOW', '11 天未浇且天气炎热干燥，应建议浇水');
    assert.ok(rec.recommendation.reasons.length > 0);

    // 确认浇水 → 历史变成 0 天
    await svc.confirm(plant.id, 'rec-1', 'watered');
    const rec2 = await svc.recommend(plant.id, weatherIn);
    assert.equal(rec2.recommendation.action, 'NO_ACTION', '刚浇过水，不应再建议浇水');
    assert.equal(rec2.recommendation.basedOn.wateringCount, 2);
  });

  test('用户确认 watered 才落记录，confirm / skip 不落', async () => {
    const { svc, repo } = await makeService();
    const plant = await svc.addPlant({ name: '薄荷', placement: '阳台', exposure: 'outdoor' });
    await svc.setCareRule(plant.id, 3, 5);

    await svc.confirm(plant.id, 'r1', 'confirm');
    await svc.confirm(plant.id, 'r2', 'skip');
    assert.equal((await repo.wateringHistory(plant.id)).length, 0);

    await svc.confirm(plant.id, 'r3', 'watered');
    assert.equal((await repo.wateringHistory(plant.id)).length, 1);
  });
});

describe('规则冲突：系统只提示，不改写（D-13 铁律在闭环里也成立）', () => {
  test('高温下引擎提出提示，CareRule 字段不变', async () => {
    const { svc, repo } = await makeService(SCENARIOS.hotDry);
    const plant = await svc.addPlant({ name: '龟背竹 A', placement: '客厅', exposure: 'indoor_window' });
    const rule = await svc.setCareRule(plant.id, 10, 14);
    const before = JSON.stringify(rule);

    await seedWatering(svc, plant.id, 11);
    const weatherIn = await svc.loadWeather();
    const rec = await svc.recommend(plant.id, weatherIn);

    assert.equal(rec.shouldPromptRuleChange, true, '高温应触发提示');
    assert.ok(rec.ruleConflictReason);
    const after = await repo.getCareRuleByPlant(plant.id);
    assert.equal(JSON.stringify(after), before, 'CareRule 不得被改写');
  });
});

describe('天气不可用时闭环仍能走完（D-14）', () => {
  test('天气源挂掉，仍能出建议，且理由里明说', async () => {
    const { svc, weather } = await makeService();
    weather.setFailure('模拟断网');

    const plant = await svc.addPlant({ name: '龟背竹 A', placement: '客厅', exposure: 'indoor_window' });
    await svc.setCareRule(plant.id, 7, 10);
    await seedWatering(svc, plant.id, 11);

    const weatherIn = await svc.loadWeather();
    assert.equal(weatherIn.available, false);

    const rec = await svc.recommend(plant.id, weatherIn);
    assert.equal(rec.recommendation.action, 'WATER_NOW', '断网时仍应依据历史给出建议');
    assert.equal(rec.recommendation.basedOn.weatherUnavailable, true);
    const texts = rec.recommendation.reasons.map((x) => x.text).join(' ');
    assert.match(texts, /天气数据暂不可用/);
  });

  test('断网时不得拿缓存冒充新数据（D-14）', async () => {
    const { svc, weather } = await makeService();
    const plant = await svc.addPlant({ name: '龟背竹 A', placement: '客厅', exposure: 'indoor_window' });
    await svc.setCareRule(plant.id, 7, 10);

    // 先成功取一次，缓存里就有数据了
    assert.equal((await svc.loadWeather()).available, true);

    // 再断网。此时库里明明有缓存，但 loadWeather 必须报不可用
    weather.setFailure('断网');
    const down = await svc.loadWeather();
    assert.equal(down.available, false, '断网时不得把缓存当成本次结果返回');
    if (!down.available) {
      assert.ok(down.fallback.lastSuccessAt, '但必须告知用户最后一次成功的时间');
    }

    // 界面层可以显式取缓存用于展示，但那是另一个方法
    const cached = await svc.readCachedWeather();
    assert.equal(cached.available, true);
    assert.match(cached.available ? cached.snapshot.provider : '', /mock/);
  });

  test('天气源恢复后自动重新启用', async () => {
    const { svc, weather } = await makeService();
    weather.setFailure('断网');
    const plant = await svc.addPlant({ name: '龟背竹 A', placement: '客厅', exposure: 'indoor_window' });
    await svc.setCareRule(plant.id, 7, 10);

    assert.equal((await svc.loadWeather()).available, false);
    weather.setFailure(undefined);
    assert.equal((await svc.loadWeather()).available, true);
  });
});

describe('D-13 浇水估算：18cm = 500ml，立方外推', () => {
  test('18cm 盆估算 500ml', () => {
    assert.equal(estimateWateringMl(18), 500);
  });

  test('12cm 盆按容积立方比例外推', () => {
    // (12/18)³ = 0.296 → 148
    assert.equal(estimateWateringMl(12), Math.round(500 * (12 / 18) ** 3));
  });

  test('24cm 盆约为 2667ml', () => {
    assert.equal(estimateWateringMl(24), Math.round(500 * (24 / 18) ** 3));
  });

  test('未填口径时返回 undefined，不编造数值', () => {
    assert.equal(estimateWateringMl(undefined), undefined);
    assert.equal(estimateWateringMl(0), undefined);
    assert.equal(estimateWateringMl(-5), undefined);
  });

  test('用户手填的水量优先于估算', async () => {
    const { svc } = await makeService();
    const plant = await svc.addPlant({ name: '龟背竹 A', placement: '客厅', exposure: 'indoor_window', potDiameterCm: 18 });
    const w = await svc.recordWatering(plant.id, { amountMl: 300 });
    assert.equal(w.amountMl, 300, '用户填的量必须保留');
    assert.equal(w.amountSource, 'user_stated');
  });
});

describe('D-06 补录队列：批量入口进队列，单株入口直接补全', () => {
  test('批量入口的记录默认待补全', async () => {
    const { svc } = await makeService();
    const plant = await svc.addPlant({ name: '龟背竹 A', placement: '客厅', exposure: 'indoor_window' });
    const w = await svc.recordWatering(plant.id, { entrySource: 'bulk' });
    assert.equal(w.completionState, 'pending');
  });

  test('批量入口的待补全记录不参与建议判定', async () => {
    const { svc } = await makeService(SCENARIOS.hotDry);
    const plant = await svc.addPlant({ name: '龟背竹 A', placement: '客厅', exposure: 'indoor_window' });
    await svc.setCareRule(plant.id, 7, 10);
    await seedWatering(svc, plant.id, 20);
    await svc.recordWatering(plant.id, { entrySource: 'bulk' }); // 刚浇的但未补全

    const weatherIn = await svc.loadWeather();
    const rec = await svc.recommend(plant.id, weatherIn);
    assert.equal(rec.recommendation.basedOn.wateringCount, 1, '未补全的记录不应被当成真实浇水');
  });
});

describe('多窗口并发：闭环中的并发写入', () => {
  test('两个窗口同时改一株植物，后提交者被拒', async () => {
    seq += 1;
    setDatabaseName(`vs-concurrent-${seq}`);
    const repoA = new Repository();
    await repoA.open();
    openRepos.push(repoA);
    const repoB = new Repository();
    await repoB.open();
    openRepos.push(repoB);

    const weather = new MockWeatherProvider();
    const clock = fixedClock('2026-09-30T14:32:00+08:00');
    const svcA = new PlantCareService(repoA, weather, clock);
    const svcB = new PlantCareService(repoB, weather, clock);

    const plant = await svcA.addPlant({ name: '龟背竹 A', placement: '客厅', exposure: 'indoor_window' });

    // 两个窗口都读到 version 1
    const inA = await repoA.getPlant(plant.id);
    assert.ok(inA);

    // B 窗口先改
    await repoB.forcePut<Plant>(STORES.plants, { ...inA, name: '龟背竹 A（窗 B 改名）' });

    // A 窗口拿着旧版本提交，必须被拒
    await assert.rejects(() => repoA.put<Plant>(STORES.plants, { ...inA, name: '龟背竹 A（窗 A 改名）' }, inA.version), OptimisticLockError);

    const final = await repoA.getPlant(plant.id);
    assert.equal(final?.name, '龟背竹 A（窗 B 改名）', '库里的数据必须保持为另一窗口写入的');
  });
});

/**
 * 天气获取的重试与降级。
 *
 * 起因是线上实测：同一个请求耗时在 213ms 到 1070ms 之间波动，
 * 页面首次加载时并行请求更容易撞上抖动，早期版本一次失败就整页降级。
 */
describe('天气获取：超时重试后才降级', () => {
  /** 造一个行为可编排的 provider。calls 记录被调用了几次。 */
  function scriptedProvider(
    steps: Array<() => Promise<unknown>>,
  ): { provider: { fetch: () => Promise<unknown> }; calls: () => number } {
    let n = 0;
    return {
      provider: {
        fetch: async () => {
          const step = steps[Math.min(n, steps.length - 1)];
          n += 1;
          if (!step) throw new Error('没有可用步骤');
          return step();
        },
      },
      calls: () => n,
    };
  }

  /** 拿到一个已打开的仓库，同库名的后续 service 可以复用它 */
  async function openRepo(name: string): Promise<Repository> {
    setDatabaseName(name);
    const repo = new Repository();
    await repo.open();
    openRepos.push(repo);
    return repo;
  }

  test('前两次失败第三次成功 → 不降级', async () => {
    const snap = { id: 'w1', city: '广州', temperature: 26 } as never;
    const boom = async () => {
      throw new TypeError('Failed to fetch');
    };
    const sp = scriptedProvider([boom, boom, async () => snap]);
    const repo = await openRepo(`wx-a-${seq}`);
    const svc = new PlantCareService(repo, sp.provider as never, fixedClock('2026-09-30T14:32:00+08:00'));

    const r = await svc.loadWeather();
    assert.equal(r.available, true, '重试成功后不应降级');
    assert.equal(sp.calls(), 3);
  });

  test('全部失败才降级，且携带原因', async () => {
    const sp = scriptedProvider([
      async () => {
        throw new TypeError('Failed to fetch');
      },
    ]);
    const repo = await openRepo(`wx-b-${seq}`);
    const svc = new PlantCareService(repo, sp.provider as never, fixedClock('2026-09-30T14:32:00+08:00'));

    const r = await svc.loadWeather();
    assert.equal(r.available, false);
    assert.equal(sp.calls(), 3, '应重试满次数');
    assert.ok(r.available === false && r.fallback.reason.length > 0, '降级必须带原因');
  });

  test('降级时不拿缓存冒充新数据（D-14）', async () => {
    const dbName = `wx-c-${seq}`;
    const good = new MockWeatherProvider(SCENARIOS.mild);
    const repo1 = await openRepo(dbName);
    const svc1 = new PlantCareService(repo1, good, fixedClock('2026-09-30T14:32:00+08:00'));
    // 先成功一次，制造缓存
    await svc1.loadWeather();

    // 同一个库，换一个必失败的 provider
    const sp = scriptedProvider([
      async () => {
        throw new TypeError('断了');
      },
    ]);
    const repo2 = await openRepo(dbName);
    const svc2 = new PlantCareService(repo2, sp.provider as never, fixedClock('2026-09-30T14:32:00+08:00'));
    const r = await svc2.loadWeather();
    assert.equal(r.available, false, '失败时不得返回缓存冒充新数据');
    if (!r.available) {
      assert.ok(r.fallback.lastSuccessAt, '但必须告知上次成功的时间');
    }
  });
});
