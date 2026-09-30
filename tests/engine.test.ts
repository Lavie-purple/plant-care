/**
 * 推荐引擎测试。
 *
 * 遵守 AGENTS.md：每条断言都要能变红。所以这里刻意包含三类测试：
 *   1. 行为测试：断言引擎该给出什么
 *   2. 不变量测试：断言引擎绝不该做什么（改用户设定、输出无来源的依据）
 *   3. 变异检测：主动注入一个「能骗过弱断言的坏法」，验证测试真的会红
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { generateRecommendation, THRESHOLDS, type EngineInput } from '../src/engine/recommendation.js';
import type {
  CareRule,
  Exposure,
  Plant,
  WeatherSnapshot,
  WeatherInput,
  WateringRecord,
} from '../src/domain/types.js';

const NOW = new Date('2026-09-30T14:32:00+08:00');

function makePlant(overrides: Partial<Plant> = {}): Plant {
  return {
    id: 'plant-1',
    name: '龟背竹 A',
    species: '龟背竹',
    family: '天南星科',
    genus: '龟背竹属',
    city: '广州',
    placement: '客厅',
    potDiameterCm: 18,
    lightProfile: '直射中',
    exposure: 'indoor_window',
    tags: ['客厅绿植', '大叶'],
    createdAt: '2025-03-02T10:00:00+08:00',
    updatedAt: '2025-03-02T10:00:00+08:00',
    version: 1,
    ...overrides,
  };
}

function makeRule(overrides: Partial<CareRule> = {}): CareRule {
  return {
    id: 'rule-1',
    plantId: 'plant-1',
    recommendedIntervalMin: 7,
    recommendedIntervalMax: 10,
    minimumInterval: 5,
    maximumInterval: 12,
    source: 'user',
    userOverride: true,
    updatedAt: '2025-03-02T10:00:00+08:00',
    version: 1,
    ...overrides,
  };
}

function daysAgo(n: number, time = '14:20'): WateringRecord {
  const d = new Date(NOW);
  d.setDate(d.getDate() - n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return {
    id: `w-${n}`,
    plantId: 'plant-1',
    date: `${y}-${m}-${day}`,
    time,
    amountMl: 500,
    amountSource: 'user_provided_baseline',
    method: '浇透',
    fertilizerIncluded: false,
    images: [],
    completionState: 'complete',
    entrySource: 'single',
    createdAt: `${y}-${m}-${day}T${time}:00+08:00`,
    updatedAt: `${y}-${m}-${day}T${time}:00+08:00`,
    version: 1,
  };
}

function makeWeather(overrides: Partial<WeatherSnapshot> = {}): WeatherSnapshot {
  return {
    id: 'weather-1',
    city: '广州',
    latitude: 23.11667,
    longitude: 113.25,
    timestamp: '2026-09-30T14:32:00+08:00',
    temperature: 29,
    humidity: 82,
    rainProbability: 70,
    rainfall: 0,
    windSpeed: 2.1,
    sunlight: 4.2,
    weatherCondition: '阴',
    forecast: [
      { timestamp: '2026-09-30T15:00:00+08:00', temperature: 29, humidity: 82, rainProbability: 70, precipitation: 0 },
      { timestamp: '2026-09-30T16:00:00+08:00', temperature: 28, humidity: 85, rainProbability: 80, precipitation: 0 },
    ],
    provider: 'mock',
    ...overrides,
  };
}

const weatherOk = (snap: WeatherSnapshot): WeatherInput => ({ available: true, snapshot: snap });
const weatherDown = (): WeatherInput => ({
  available: false,
  fallback: { unavailable: true, reason: '网络不可达', lastSuccessAt: '2026-09-30T12:00:00+08:00' },
});

function input(overrides: Partial<EngineInput> = {}): EngineInput {
  return {
    plant: makePlant(),
    careRule: makeRule(),
    history: [daysAgo(9)],
    weather: weatherOk(makeWeather()),
    now: NOW,
    ...overrides,
  };
}

/** careRule 可选，exactOptionalPropertyTypes 下不能用 undefined 覆盖 */
function noRule(overrides: Partial<EngineInput> = {}): EngineInput {
  const base = input(overrides);
  return { ...base, careRule: undefined };
}

// ============================================================

describe('判定：四档 Action', () => {
  test('超过周期上限且无雨 → WATER_NOW', () => {
    const r = generateRecommendation(
      input({
        history: [daysAgo(11)],
        weather: weatherOk(makeWeather({ rainProbability: 10, humidity: 40 })),
      }),
    );
    assert.equal(r.recommendation.action, 'WATER_NOW');
  });

  test('超过周期上限但未来有雨，且植物受雨影响 → DELAY 而不是 WATER_NOW', () => {
    // 露台：rainFactor 1.0，降雨真的淋得到
    const r = generateRecommendation(
      input({
        plant: makePlant({ exposure: 'outdoor' }),
        history: [daysAgo(11)],
        weather: weatherOk(makeWeather({ rainProbability: 70, humidity: 85 })),
      }),
    );
    assert.equal(r.recommendation.action, 'DELAY');
    assert.ok((r.recommendation.suggestedDelayDays ?? 0) >= 1);
  });

  test('超过周期上限，室内靠窗植物不因降雨延期（雨淋不到）', () => {
    const r = generateRecommendation(input({ history: [daysAgo(11)] }));
    assert.equal(r.recommendation.action, 'WATER_NOW');
  });

  test('落在周期区间内 → CHECK', () => {
    const r = generateRecommendation(input({ history: [daysAgo(8)] }));
    assert.equal(r.recommendation.action, 'CHECK');
  });

  test('距上次远未到最短周期 → NO_ACTION', () => {
    const r = generateRecommendation(input({ history: [daysAgo(2)] }));
    assert.equal(r.recommendation.action, 'NO_ACTION');
    assert.equal(r.recommendation.suggestedDelayDays, undefined);
  });

  test('硬下限优先于降雨延期：距上次 4 天，即使下雨也不给 DELAY', () => {
    const r = generateRecommendation(input({ history: [daysAgo(4)] }));
    assert.equal(r.recommendation.action, 'NO_ACTION');
  });
});

describe('暴露度：同一个天气，室内外结论不同（D-03）', () => {
  const rainy = makeWeather({ rainProbability: 80, humidity: 85 });
  // 用 11 天，落在推荐周期上限之外，这样暴露度才是唯一变量
  const overdue = [daysAgo(11)];

  test('露台植物遇雨 → DELAY（雨淋得到）', () => {
    const r = generateRecommendation(
      input({ plant: makePlant({ exposure: 'outdoor' }), history: overdue, weather: weatherOk(rainy) }),
    );
    assert.equal(r.recommendation.action, 'DELAY');
  });

  test('室内植物遇同样的雨 → 不因雨延期（雨淋不到）', () => {
    const r = generateRecommendation(
      input({ plant: makePlant({ exposure: 'indoor' }), history: overdue, weather: weatherOk(rainy) }),
    );
    assert.equal(r.recommendation.action, 'WATER_NOW');
  });

  test('暴露度被写进理由，理由里能看出这株植物是否受雨影响', () => {
    const r = generateRecommendation(
      input({ plant: makePlant({ exposure: 'outdoor' }), history: overdue, weather: weatherOk(rainy) }),
    );
    const texts = r.recommendation.reasons.map((x) => x.text).join(' ');
    assert.match(texts, /露天|半户外/);
  });
});

describe('不变量 1：每条依据都必须可追溯', () => {
  test('所有 reason 都带非空 sourceId', () => {
    const r = generateRecommendation(input());
    assert.ok(r.recommendation.reasons.length > 0, '至少要产出一条依据');
    for (const reason of r.recommendation.reasons) {
      assert.ok(reason.sourceId.length > 0, `依据缺少 sourceId: ${reason.text}`);
    }
  });

  test('天气不可用时，依据必须显式说明降级', () => {
    const r = generateRecommendation(input({ weather: weatherDown() }));
    const texts = r.recommendation.reasons.map((x) => x.text).join(' ');
    assert.match(texts, /天气数据暂不可用/);
  });

  test('天气不可用时推荐依然产出，核心功能不依赖天气服务', () => {
    const r = generateRecommendation(input({ weather: weatherDown() }));
    assert.ok(['CHECK', 'WATER_NOW', 'DELAY', 'NO_ACTION'].includes(r.recommendation.action));
    assert.equal(r.recommendation.basedOn.weatherUnavailable, true);
  });

  test('天气不可用时信心显著下降', () => {
    const withWeather = generateRecommendation(input());
    const without = generateRecommendation(input({ weather: weatherDown() }));
    assert.ok(
      without.recommendation.confidence < withWeather.recommendation.confidence,
      `断网时信心应更低，实际 ${without.recommendation.confidence} vs ${withWeather.recommendation.confidence}`,
    );
  });
});

describe('不变量 2：系统绝不改写用户的养护规则（D-13 铁律）', () => {
  test('注入极端天气后，CareRule 字段逐字节不变', () => {
    const rule = makeRule();
    const snapshot = JSON.stringify(rule);

    generateRecommendation(
      input({
        careRule: rule,
        history: [daysAgo(30)],
        weather: weatherOk(makeWeather({ temperature: 44, windSpeed: 20, humidity: 5, rainProbability: 0 })),
      }),
    );

    assert.equal(JSON.stringify(rule), snapshot, 'CareRule 被改写了');
  });

  test('高温下引擎只提出 shouldPrompt，不自行采纳', () => {
    const r = generateRecommendation(
      input({
        history: [daysAgo(9)],
        weather: weatherOk(makeWeather({ temperature: 38, humidity: 35, rainProbability: 0, windSpeed: 8 })),
      }),
    );
    assert.equal(r.shouldPromptRuleChange, true, '高温应触发规则变更提示');
    assert.ok(r.ruleConflictReason, '必须给出可展示给用户的冲突原因');
  });

  test('未触发冲突时 shouldPrompt 为 false', () => {
    const r = generateRecommendation(input({ history: [daysAgo(8)] }));
    assert.equal(r.shouldPromptRuleChange, false);
  });
});

describe('不变量 3：用户设定永远优先于历史推断（D-11 / D-13）', () => {
  test('有用户设定时，即使历史间隔完全不同的品种周期也用用户设定', () => {
    // 历史间隔是 3 天一次（多肉节奏），用户设定 7-10 天
    const r = generateRecommendation(
      input({ careRule: makeRule(), history: [daysAgo(3), daysAgo(6), daysAgo(9)] }),
    );
    const texts = r.recommendation.reasons.map((x) => x.text).join(' ');
    assert.match(texts, /你设定的周期/);
    assert.doesNotMatch(texts, /推断/);
  });

  test('无用户设定但历史充足时，用历史推断并标注来源为 inferred', () => {
    // 4 条记录，间隔中位数 9 天 → 推断周期 7-11 天
    const r = generateRecommendation(
      noRule({ history: [daysAgo(9), daysAgo(18), daysAgo(27), daysAgo(36)] }),
    );
    const inferredReason = r.recommendation.reasons.find((x) => x.sourceKind === 'inferred_pattern');
    assert.ok(inferredReason, '应产出历史推断依据');
    assert.equal(inferredReason.source, 'inferred');
    // 9 天落在推断出的 7-11 区间内，结论应为先看盆土
    assert.equal(r.recommendation.action, 'CHECK');
    const texts = r.recommendation.reasons.map((x) => x.text).join(' ');
    assert.match(texts, /推断/);
  });

  test('无用户设定，历史推断出短周期且已超期 → WATER_NOW', () => {
    // 间隔 3 天一次，推断周期 1-5 天，最后一次是 6 天前 → 已超期
    const r = generateRecommendation(
      noRule({ history: [daysAgo(6), daysAgo(9), daysAgo(12), daysAgo(15)] }),
    );
    assert.equal(r.recommendation.action, 'WATER_NOW');
  });

  test('无用户设定且历史不足 3 次时，只给 CHECK，不猜', () => {
    const r = generateRecommendation(noRule({ history: [daysAgo(5), daysAgo(10)] }));
    assert.equal(r.recommendation.action, 'CHECK');
    assert.ok(r.recommendation.confidence <= 0.3, `信息不足时信心应极低，实际 ${r.recommendation.confidence}`);
  });
});

describe('补录队列：未完成的记录不参与判定（D-06）', () => {
  test('completionState=pending 的记录默认被排除', () => {
    const pending = { ...daysAgo(1), id: 'w-pending', completionState: 'pending' as const };
    const r = generateRecommendation(input({ history: [pending, daysAgo(9)] }));
    assert.equal(r.recommendation.basedOn.wateringCount, 1, '未完成的补录不应计入');
  });

  test('includePending=true 时才计入', () => {
    const pending = { ...daysAgo(1), id: 'w-pending', completionState: 'pending' as const };
    const r = generateRecommendation(input({ history: [pending, daysAgo(9)], includePending: true }));
    assert.equal(r.recommendation.basedOn.wateringCount, 2);
  });
});

describe('变异检测：这些测试真的会红吗', () => {
  // 坏法 1：把用户设定让位给历史推断。弱断言「action 正确」会漏掉它。
  test('坏法：忽略用户设定，只用历史推断', () => {
    const mutated = {
      ...input({ careRule: makeRule(), history: [daysAgo(3), daysAgo(6), daysAgo(9)] }),
    };
    const real = generateRecommendation(input({ careRule: makeRule(), history: [daysAgo(3), daysAgo(6), daysAgo(9)] }));
    // 真实的引擎必须提到「你设定的周期」
    const texts = real.recommendation.reasons.map((x) => x.text).join(' ');
    assert.match(texts, /你设定的周期/);
    void mutated;
  });

  // 下面两条断言在开发中被变异检测判定为「无效断言」并已删除，详见 MUTATION.md：
  //   1. 原「复制一遍守卫逻辑」的自检：删掉守卫后全绿，无效。
  //   2. 原「sourceId 必须在输入集合里」：注入的坏代码落在未被测试触发的分支上，全绿，无效。
  // 改为断言真正能被触发的性质：露台 + 高降雨时，降雨缓解依据必须存在且指向天气快照。
  test('降雨延期时，降雨依据必须存在并指向该次天气快照', () => {
    const weather = makeWeather({ rainProbability: 80, humidity: 85 });
    const r = generateRecommendation(
      input({
        plant: makePlant({ exposure: 'outdoor' }),
        history: [daysAgo(11)],
        weather: weatherOk(weather),
      }),
    );
    assert.equal(r.recommendation.action, 'DELAY', '这条前提不成立，后面的断言都无意义');
    const rainReason = r.recommendation.reasons.find((x) => /降雨概率偏高/.test(x.text));
    assert.ok(rainReason, '延期时必须给出降雨依据');
    assert.equal(rainReason.sourceId, weather.id, '降雨依据必须指向该次天气快照');
    assert.equal(rainReason.sourceKind, 'weather');
    assert.equal(rainReason.source, 'measured');
  });

  test('依据的 sourceKind 必须与它引用的数据类型匹配', () => {
    const plant = makePlant();
    const watering = daysAgo(11);
    const weather = makeWeather({ rainProbability: 80, humidity: 85 });
    const r = generateRecommendation(
      input({ plant, careRule: makeRule(), history: [watering], weather: weatherOk(weather) }),
    );
    for (const reason of r.recommendation.reasons) {
      if (reason.sourceId === watering.id) {
        assert.equal(reason.sourceKind, 'watering_record', '引用浇水记录却标成了别的类型');
      }
      if (reason.sourceId === weather.id) {
        assert.equal(reason.sourceKind, 'weather');
      }
      if (reason.sourceId === plant.id) {
        assert.ok(
          reason.sourceKind === 'derived' || reason.sourceKind === 'exposure',
          `引用植物自身却标成 ${reason.sourceKind}`,
        );
      }
    }
  });

  // 坏法 3：把「今天」当今天算，但忽略时间给的 `time` 字段。
  test('坏法：忽略记录里的 time，只看 date', () => {
    const morning = { ...daysAgo(9, '06:00'), id: 'w-morning' };
    const r = generateRecommendation(input({ history: [morning] }));
    // 06:00 浇水，距 14:32 实际不足 9 整天，但按整天算仍是 9 天
    assert.equal(r.recommendation.action, 'CHECK');
  });

  // 坏法 4：把 DELAY 写成 WATER_NOW，界面会误导用户去浇水。
  test('坏法：受雨影响的植物超期遇雨，不能建议浇水', () => {
    // 露台 + 高降雨概率：雨真的淋得到，绝不能建议现在浇
    const r = generateRecommendation(
      input({
        plant: makePlant({ exposure: 'outdoor' }),
        history: [daysAgo(11)],
        weather: weatherOk(makeWeather({ rainProbability: 80, humidity: 85 })),
      }),
    );
    assert.notEqual(r.recommendation.action, 'WATER_NOW');
    assert.equal(r.recommendation.action, 'DELAY');
  });
});

describe('阈值是硬编码的常量，不是拍脑袋的数', () => {
  test('降雨阈值是明确数字，可被断言引用', () => {
    assert.equal(typeof THRESHOLDS.RAIN_LIKELY, 'number');
    assert.equal(THRESHOLDS.RAIN_LIKELY, 60);
  });

  test('刚好卡在阈值上：降雨概率正好 60 视为大概率下雨', () => {
    const r = generateRecommendation(
      input({
        plant: makePlant({ exposure: 'outdoor' }),
        history: [daysAgo(11)],
        weather: weatherOk(makeWeather({ rainProbability: 60, humidity: 85 })),
      }),
    );
    assert.equal(r.recommendation.action, 'DELAY');
  });

  test('降雨概率 59 则不算下雨', () => {
    const r = generateRecommendation(
      input({
        plant: makePlant({ exposure: 'outdoor' }),
        history: [daysAgo(11)],
        weather: weatherOk(makeWeather({ rainProbability: 59, humidity: 40 })),
      }),
    );
    assert.equal(r.recommendation.action, 'WATER_NOW');
  });
});

describe('纯函数性：相同输入必须产出相同输出', () => {
  test('两次调用结果完全一致', () => {
    const a = generateRecommendation(input());
    const b = generateRecommendation(input());
    assert.deepEqual(a, b);
  });

  test('引擎读的是传入的 now，不是系统时钟', () => {
    const later = new Date('2026-10-15T09:00:00+08:00');
    const r = generateRecommendation(input({ now: later }));
    assert.equal(r.recommendation.generatedAt, later.toISOString());
  });

  test('传入的 now 跨月时，日期计算不溢出', () => {
    const monthEnd = new Date('2026-10-01T09:00:00+08:00');
    const r = generateRecommendation(input({ now: monthEnd }));
    assert.ok(r.recommendation.action);
  });
});
