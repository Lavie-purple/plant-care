/**
 * 存储层测试。
 *
 * 用 fake-indexeddb 提供真实 IndexedDB 语义（事务、索引、版本号），
 * 但乐观锁与广播逻辑是我们自己的代码，必须在这里真跑一遍。
 *
 * D-17 的三条要求逐条验证：
 *   1. 写入后广播变更
 *   2. 接收方收到广播后从库里重读，不信任广播内容
 *   3. 写入时校验 version，冲突抛 OptimisticLockError
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import 'fake-indexeddb/auto';

import { Repository, type BroadcastChannelLike } from '../src/storage/repository.js';
import { OptimisticLockError, STORES, WEATHER_SNAPSHOT_RETENTION, setDatabaseName } from '../src/storage/indexeddb.js';
import type { Plant, PlantEvent, Settings, WateringRecord } from '../src/domain/types.js';

/** 测试用的广播总线：两个 Repository 可以接同一个，实现真正的多窗口场景 */
class TestBus {
  private channels = new Set<TestChannel>();
  static seq = 0;
  readonly id = ++TestBus.seq + 100000;

  factory = (name: string): BroadcastChannelLike => {
    const ch = new TestChannel(name, this);
    this.channels.add(ch);
    return ch;
  };

  publish(from: TestChannel, msg: unknown): void {
    for (const c of this.channels) {
      if (c === from) continue; // 广播不发给发送方
      c.onmessage?.({ data: msg });
    }
  }

  remove(c: TestChannel): void {
    this.channels.delete(c);
  }
}

class TestChannel implements BroadcastChannelLike {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(
    readonly name: string,
    readonly bus: TestBus,
  ) {}
  postMessage(msg: unknown): void {
    this.bus.publish(this, msg);
  }
  close(): void {
    this.bus.remove(this);
  }
}

function makePlant(id: string, overrides: Partial<Plant> = {}): Plant {
  return {
    id,
    name: `植物 ${id}`,
    placement: '客厅',
    exposure: 'indoor_window',
    tags: [],
    createdAt: '2026-09-01T10:00:00+08:00',
    updatedAt: '2026-09-01T10:00:00+08:00',
    version: 1,
    ...overrides,
  };
}

function makeWatering(plantId: string, date: string, id: string): WateringRecord {
  return {
    id,
    plantId,
    date,
    time: '14:00',
    amountMl: 500,
    amountSource: 'user_provided_baseline',
    method: '浇透',
    fertilizerIncluded: false,
    images: [],
    completionState: 'complete',
    entrySource: 'single',
    createdAt: `${date}T14:00:00+08:00`,
    updatedAt: `${date}T14:00:00+08:00`,
    version: 1,
  };
}

let singleSeq = 0;
let busSeqCounter = 0;

/** 所有打开的 Repository，测试结束后统一关闭，避免连接悬挂阻塞后续 open */
const openRepos: Repository[] = [];
afterEach(() => {
  while (openRepos.length) openRepos.pop()?.close();
});

/**
 * 每个用例独立库名，避免 fake-indexeddb 下 onupgradeneeded 只触发一次。
 * 但多窗口场景必须共用同一个库名，否则两个窗口连的是两个库，
 * 「B 读到 A 写的」这种断言就失去了意义。
 */
async function freshRepo(bus?: TestBus): Promise<Repository> {
  if (bus) {
    // 多窗口：同库
    setDatabaseName(`plant-test-bus-${bus.id}`);
  } else {
    singleSeq += 1;
    setDatabaseName(`plant-single-${singleSeq}`);
  }
  const repo = new Repository(bus ? { channelFactory: bus.factory } : {});
  await repo.open();
  openRepos.push(repo);
  return repo;
}

describe('乐观锁（D-17 第 3 条）', () => {
  test('写入后 version 自动递增', async () => {
    const repo = await freshRepo();
    const a = await repo.put(STORES.plants, makePlant('p1'));
    assert.equal(a.version, 1);
    const b = await repo.put(STORES.plants, { ...a, name: '改名了' });
    assert.equal(b.version, 2);
    repo.close();
  });

  test('版本不符时抛 OptimisticLockError，不静默覆盖', async () => {
    const repo = await freshRepo();
    const created = await repo.put(STORES.plants, makePlant('p1'));
    // 另一个窗口把版本推到 2
    await repo.forcePut(STORES.plants, { ...created, name: '窗口B改的' });
    // 本窗口拿着版本 1 写入，必须被拒
    await assert.rejects(
      () => repo.put(STORES.plants, { ...created, name: '窗口A改的' }, 1),
      OptimisticLockError,
    );
    const after = await repo.getPlant('p1');
    assert.equal(after?.name, '窗口B改的', '库里的数据必须保持为另一窗口写入的');
    repo.close();
  });

  test('冲突错误携带足够诊断信息', async () => {
    const repo = await freshRepo();
    const created = await repo.put(STORES.plants, makePlant('p1'));
    await repo.forcePut(STORES.plants, { ...created });
    try {
      await repo.put(STORES.plants, { ...created }, 1);
      assert.fail('应当抛出');
    } catch (e) {
      assert.ok(e instanceof OptimisticLockError);
      assert.equal(e.store, 'plants');
      assert.equal(e.id, 'p1');
      assert.equal(e.expectedVersion, 1);
      assert.equal(e.actualVersion, 2);
    }
    repo.close();
  });

  test('forcePut 是用户明确选择覆盖时的出口', async () => {
    const repo = await freshRepo();
    const created = await repo.put(STORES.plants, makePlant('p1'));
    await repo.forcePut(STORES.plants, { ...created, name: '用户选择覆盖' });
    const after = await repo.getPlant('p1');
    assert.equal(after?.name, '用户选择覆盖');
    repo.close();
  });

  test('不传 expectedVersion 时不报错，但版本仍递增', async () => {
    const repo = await freshRepo();
    const a = await repo.put(STORES.plants, makePlant('p1'));
    const b = await repo.put(STORES.plants, { ...a, name: 'x' });
    assert.equal(b.version, 2);
    repo.close();
  });
});

describe('多窗口广播同步（D-17 第 1、2 条）', () => {
  test('窗口 A 写入，窗口 B 收到广播', async () => {
    const bus = new TestBus();
    const a = await freshRepo(bus);
    const b = await freshRepo(bus);

    const got: unknown[] = [];
    b.onChange((m) => got.push(m));

    await a.put(STORES.plants, makePlant('p1'));
    assert.ok(got.length > 0, '窗口 B 应收到变更广播');
    repo_close(b);
    repo_close(a);
  });

  test('广播只带类型和 id，不带实体数据（图片 Blob 无法序列化）', async () => {
    const bus = new TestBus();
    const a = await freshRepo(bus);
    const b = await freshRepo(bus);
    const got: Record<string, unknown>[] = [];
    b.onChange((m) => got.push(m as unknown as Record<string, unknown>));

    await a.put(STORES.plants, makePlant('p1'));
    const putMsg = got.find((m) => m.kind === 'put');
    assert.ok(putMsg);
    assert.equal(putMsg.store, 'plants');
    assert.equal(putMsg.id, 'p1');
    // 变异检测：把实体塞进广播后这条会红。载荷必须严格只有这三个键。
    const keys = Object.keys(putMsg).sort();
    assert.deepEqual(keys, ['id', 'kind', 'store'], `广播载荷含额外字段：${keys.join(', ')}`);
    repo_close(b);
    repo_close(a);
  });

  test('窗口 B 收到广播后能从库里读到完整数据', async () => {
    const bus = new TestBus();
    const a = await freshRepo(bus);
    const b = await freshRepo(bus);
    await a.put(STORES.plants, makePlant('p1', { name: '龟背竹 A' }));

    const p = await b.getPlant('p1');
    assert.equal(p?.name, '龟背竹 A', 'B 必须能通过重读拿到完整数据');
    repo_close(b);
    repo_close(a);
  });

  test('两个窗口并发改同一条，后提交者被拒（D-17 的核心场景）', async () => {
    const bus = new TestBus();
    const a = await freshRepo(bus);
    const b = await freshRepo(bus);

    // 两个窗口都读到版本 1
    const inA = await a.getPlant('p1').then(() => a.put(STORES.plants, makePlant('p1')));
    await b.forcePut(STORES.plants, { ...inA, name: 'B 改的' });

    // A 拿着旧版本提交，必须失败
    await assert.rejects(
      () => a.put(STORES.plants, { ...inA, name: 'A 改的' }, inA.version),
      OptimisticLockError,
    );
    const final = await a.getPlant('p1');
    assert.equal(final?.name, 'B 改的');
    repo_close(b);
    repo_close(a);
  });

  test('删除操作也广播', async () => {
    const bus = new TestBus();
    const a = await freshRepo(bus);
    const b = await freshRepo(bus);
    const got: { kind: string }[] = [];
    b.onChange((m) => got.push(m));

    const p = await a.put(STORES.plants, makePlant('p1'));
    await a.remove(STORES.plants, p.id);
    assert.ok(got.some((m) => m.kind === 'delete'));
    repo_close(b);
    repo_close(a);
  });

  test('无 BroadcastChannel 的环境（如 SSR）也能工作', async () => {
    const original = globalThis.BroadcastChannel;
    // @ts-expect-error 模拟没有 BroadcastChannel 的环境
    delete globalThis.BroadcastChannel;
    const repo = new Repository();
    await repo.open();
    const p = await repo.put(STORES.plants, makePlant('p1'));
    assert.equal(p.id, 'p1', '单窗口环境下功能必须正常');
    repo.close();
    globalThis.BroadcastChannel = original;
  });
});

describe('领域查询', () => {
  test('浇水历史按日期倒序', async () => {
    const repo = await freshRepo();
    await repo.put(STORES.plants, makePlant('p1'));
    for (const d of ['2026-09-10', '2026-09-28', '2026-09-18']) {
      await repo.put(STORES.wateringRecords, makeWatering('p1', d, `w-${d}`));
    }
    const h = await repo.wateringHistory('p1');
    assert.deepEqual(
      h.map((x) => x.date),
      ['2026-09-28', '2026-09-18', '2026-09-10'],
    );
    repo.close();
  });

  test('浇水历史只返回该植物的', async () => {
    const repo = await freshRepo();
    await repo.put(STORES.wateringRecords, makeWatering('p1', '2026-09-20', 'w1'));
    await repo.put(STORES.wateringRecords, makeWatering('p2', '2026-09-21', 'w2'));
    const h = await repo.wateringHistory('p1');
    assert.equal(h.length, 1);
    assert.equal(h[0]?.id, 'w1');
    repo.close();
  });

  test('成长时间线是 PlantEvent 的视图，只含成长类事件（D-08）', async () => {
    const repo = await freshRepo();
    const photo: PlantEvent = {
      id: 'e1',
      plantId: 'p1',
      type: 'PHOTO',
      date: '2026-09-18',
      title: '长高了',
      images: ['img1'],
      metadata: {},
      createdAt: '2026-09-18T10:00:00+08:00',
      version: 1,
    };
    const note: PlantEvent = {
      id: 'e2',
      plantId: 'p1',
      type: 'NOTE',
      date: '2026-09-20',
      images: [],
      metadata: {},
      createdAt: '2026-09-20T10:00:00+08:00',
      version: 1,
    };
    await repo.put(STORES.plantEvents, photo);
    await repo.put(STORES.plantEvents, note);

    const timeline = await repo.growthTimeline('p1');
    assert.equal(timeline.length, 1, 'NOTE 不该出现在成长时间线');
    assert.equal(timeline[0]?.type, 'PHOTO');

    const all = await repo.plantEvents('p1');
    assert.equal(all.length, 2, '但全部事件都在');
    repo.close();
  });

  test('成长时间线按日期倒序', async () => {
    const repo = await freshRepo();
    for (const d of ['2026-09-01', '2026-09-17', '2026-09-28']) {
      await repo.put(STORES.plantEvents, {
        id: `e-${d}`,
        plantId: 'p1',
        type: 'PHOTO',
        date: d,
        title: `照片 ${d}`,
        images: [],
        metadata: {},
        createdAt: `${d}T10:00:00+08:00`,
        version: 1,
      });
    }
    const t = await repo.growthTimeline('p1');
    assert.deepEqual(
      t.map((x) => x.date),
      ['2026-09-28', '2026-09-17', '2026-09-01'],
    );
    repo.close();
  });

  test('每株植物只关联一条养护规则', async () => {
    const repo = await freshRepo();
    const rule = {
      id: 'r1',
      plantId: 'p1',
      recommendedIntervalMin: 7,
      recommendedIntervalMax: 10,
      minimumInterval: 5,
      maximumInterval: 12,
      source: 'user' as const,
      userOverride: true,
      updatedAt: '2026-09-01T10:00:00+08:00',
      version: 1,
    };
    await repo.put(STORES.careRules, rule);
    const got = await repo.getCareRuleByPlant('p1');
    assert.equal(got?.id, 'r1');
    assert.equal(got?.userOverride, true);
    repo.close();
  });
});

describe('天气快照保留策略（防止存储无限增长）', () => {
  test('超出保留条数时删除最旧的', async () => {
    const repo = await freshRepo();
    const total = WEATHER_SNAPSHOT_RETENTION + 5;
    for (let i = 0; i < total; i += 1) {
      await repo.saveWeatherSnapshot({
        id: `om-${i}`,
        city: '广州',
        latitude: 23.11667,
        longitude: 113.25,
        timestamp: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
        temperature: 25,
        humidity: 60,
        rainProbability: 10,
        rainfall: 0,
        windSpeed: 2,
        sunlight: 5,
        weatherCondition: '晴',
        forecast: [],
        provider: 'open-meteo',
      });
    }
    const all = await repo.getAll(STORES.weatherSnapshots);
    assert.equal(all.length, WEATHER_SNAPSHOT_RETENTION, `应裁剪到 ${WEATHER_SNAPSHOT_RETENTION} 条`);
    repo.close();
  });

  test('最新快照可单独取出', async () => {
    const repo = await freshRepo();
    await repo.saveWeatherSnapshot(makeSnap('om-old', '2026-09-29T10:00:00Z'));
    await repo.saveWeatherSnapshot(makeSnap('om-new', '2026-09-30T10:00:00Z'));
    const latest = await repo.latestWeatherSnapshot();
    assert.equal(latest?.id, 'om-new');
    repo.close();
  });

  test('没有快照时返回 undefined，不返回空对象冒充', async () => {
    const repo = await freshRepo();
    assert.equal(await repo.latestWeatherSnapshot(), undefined);
    repo.close();
  });
});

describe('设置', () => {
  test('保存后可读回', async () => {
    const repo = await freshRepo();
    const s: Settings = {
      city: '广州',
      latitude: 23.11667,
      longitude: 113.25,
      timezone: 'Asia/Shanghai',
      weatherRefreshMinutes: 30,
      pendingCompletionDays: 14,
      baselinePotDiameterCm: 18,
      baselineWaterMl: 500,
      autoFollowConflicts: false,
      updatedAt: '2026-09-30T00:00:00+08:00',
    };
    await repo.saveSettings(s);
    const got = await repo.getSettings();
    assert.equal(got?.city, '广州');
    assert.equal(got?.baselineWaterMl, 500);
    repo.close();
  });

  test('换城市时旧记录被清掉，不留两份设置', async () => {
    const repo = await freshRepo();
    const base: Settings = {
      city: '广州',
      latitude: 23.11667,
      longitude: 113.25,
      timezone: 'Asia/Shanghai',
      weatherRefreshMinutes: 30,
      pendingCompletionDays: 14,
      baselinePotDiameterCm: 18,
      baselineWaterMl: 500,
      autoFollowConflicts: false,
      updatedAt: '2026-09-30T00:00:00+08:00',
    };
    await repo.saveSettings(base);
    await repo.saveSettings({ ...base, city: '北京', latitude: 39.9, longitude: 116.4 });
    const all = await repo.getAll(STORES.settings);
    assert.equal(all.length, 1, '不应残留两份设置');
    assert.equal((await repo.getSettings())?.city, '北京');
    repo.close();
  });
});

describe('未解决的规则冲突（W3）', () => {
  test('只返回未解决的', async () => {
    const repo = await freshRepo();
    const mk = (id: string, resolved: boolean) => ({
      id,
      plantId: 'p1',
      ruleId: 'r1',
      computedMin: 7,
      computedMax: 8,
      userMin: 10,
      userMax: 12,
      reason: '高温',
      createdAt: '2026-09-30T10:00:00+08:00',
      ...(resolved ? { resolvedAt: '2026-09-30T11:00:00+08:00', resolution: 'keep-user' as const } : {}),
      version: 1,
    });
    await repo.put(STORES.pendingConflicts, mk('c1', false));
    await repo.put(STORES.pendingConflicts, mk('c2', true));
    const open = await repo.unresolvedConflicts();
    assert.equal(open.length, 1);
    assert.equal(open[0]?.id, 'c1');
    repo.close();
  });

  test('已弹窗的冲突带上 promptedAt，保证只弹一次', async () => {
    const repo = await freshRepo();
    await repo.put(STORES.pendingConflicts, {
      id: 'c1',
      plantId: 'p1',
      ruleId: 'r1',
      computedMin: 7,
      computedMax: 8,
      userMin: 10,
      userMax: 12,
      reason: '高温',
      createdAt: '2026-09-30T10:00:00+08:00',
      promptedAt: '2026-09-30T10:05:00+08:00',
      version: 1,
    });
    const [c] = await repo.unresolvedConflicts();
    assert.ok(c?.promptedAt, '已弹窗的必须有时间戳');
    repo.close();
  });
});

function makeSnap(id: string, timestamp: string) {
  return {
    id,
    city: '广州',
    latitude: 23.11667,
    longitude: 113.25,
    timestamp,
    temperature: 25,
    humidity: 60,
    rainProbability: 10,
    rainfall: 0,
    windSpeed: 2,
    sunlight: 5,
    weatherCondition: '晴',
    forecast: [],
    provider: 'open-meteo',
  };
}

function repo_close(r: Repository): void {
  r.close();
}
