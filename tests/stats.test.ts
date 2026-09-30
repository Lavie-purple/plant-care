/**
 * 统计模块测试。
 *
 * 这些数字会被用户当依据调整养护习惯，所以口径必须唯一。
 * 每条断言都在守住一个明确的口径，不测「算得对不对」这种模糊命题。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { computeStats, formatStat, STATS_BASIS, type Range } from '../src/app/stats.js';
import type { DecisionLog, UserAction, WateringRecord } from '../src/domain/types.js';

const TODAY = new Date('2026-09-30T14:32:00+08:00');

let seq = 0;
function w(daysAgo: number, over: Partial<WateringRecord> = {}): WateringRecord {
  const d = new Date(TODAY);
  d.setDate(d.getDate() - daysAgo);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const date = `${d.getFullYear()}-${m}-${day}`;
  seq += 1;
  return {
    id: `w${seq}`,
    plantId: 'p1',
    date,
    time: '14:00',
    amountMl: 500,
    amountSource: 'user_stated',
    method: '浇透',
    fertilizerIncluded: false,
    images: [],
    completionState: 'complete',
    entrySource: 'single',
    createdAt: `${date}T14:00:00+08:00`,
    updatedAt: `${date}T14:00:00+08:00`,
    version: 1,
    ...over,
  };
}

let dseq = 0;
function decision(action: UserAction, daysAgo: number): DecisionLog {
  dseq += 1;
  const d = new Date(TODAY);
  d.setDate(d.getDate() - daysAgo);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return {
    id: `d${dseq}`,
    plantId: 'p1',
    recommendationId: `r${dseq}`,
    action,
    userConfirmedAt: `${d.getFullYear()}-${m}-${day}T14:00:00+08:00`,
  };
}

function stats(history: WateringRecord[], decisions: DecisionLog[] = [], range: Range = 30) {
  return computeStats({ history, decisions, today: TODAY, range });
}

describe('区间口径：含今天，不含未来', () => {
  test('7 天区间包含今天', () => {
    const s = stats([w(0), w(3), w(6)], [], 7);
    assert.equal(s.wateringCount, 3);
  });

  test('7 天区间不含 8 天前', () => {
    const s = stats([w(0), w(8)], [], 7);
    assert.equal(s.wateringCount, 1, '8 天前应落在 7 天区间外');
  });

  test('区间边界：正好 N-1 天算在内', () => {
    const s = stats([w(6), w(7)], [], 7);
    assert.equal(s.wateringCount, 1, '6 天前在区间内，7 天前刚好在边界外');
  });

  test('未补全的记录不计入', () => {
    const s = stats([w(1), w(2, { completionState: 'pending' })], [], 30);
    assert.equal(s.wateringCount, 1, '待补录的记录不代表真实浇水');
  });
});

describe('平均间隔：样本不足时明说，不编造', () => {
  test('0 次浇水没有间隔', () => {
    const s = stats([]);
    assert.equal(s.averageIntervalDays, undefined);
    assert.equal(s.medianIntervalDays, undefined);
  });

  test('1 次浇水也算不出间隔', () => {
    const s = stats([w(1)]);
    assert.equal(s.averageIntervalDays, undefined, '1 个点算不出间隔，不能显示 0');
  });

  test('2 次浇水得出间隔', () => {
    const s = stats([w(10), w(0)]);
    assert.equal(s.averageIntervalDays, 10);
    assert.equal(s.medianIntervalDays, 10);
  });

  test('中位数抗异常值', () => {
    // 间隔 5,5,5,5,50 → 均值 24 会被拉爆，中位数仍是 5
    const s = stats([w(70), w(65), w(60), w(55), w(50), w(0)], [], 90);
    assert.equal(s.medianIntervalDays, 5);
    assert.equal(s.averageIntervalDays, 14, '均值被 50 天那个异常值拉高，但没到 20');
  });
});

describe('水量口径：估算与手填分开统计（D-07）', () => {
  test('平均值只算用户手填的', () => {
    const s = stats([w(5, { amountMl: 500, amountSource: 'user_stated' }), w(15, { amountMl: 300, amountSource: 'user_stated' })]);
    assert.equal(s.averageAmountMl, 400);
    assert.equal(s.amountSampleCount, 2);
  });

  test('估算值不进入均值，单独计数', () => {
    const s = stats([
      w(5, { amountMl: 500, amountSource: 'user_stated' }),
      w(10, { amountMl: 500, amountSource: 'user_provided_baseline' }),
    ]);
    assert.equal(s.averageAmountMl, 500, '均值只受手填值影响');
    assert.equal(s.estimatedAmountCount, 1, '估算记录要单独可见');
    assert.equal(s.amountSampleCount, 1, '参与均值的样本数必须暴露给用户');
  });

  test('全是估算时平均水量为 undefined，不拿估算冒充真实', () => {
    const s = stats([w(5, { amountSource: 'user_provided_baseline' })]);
    assert.equal(s.averageAmountMl, undefined);
    assert.equal(s.estimatedAmountCount, 1);
  });
});

describe('决定日志驱动的行为统计', () => {
  test('延期与跳过分别计数', () => {
    const s = stats([w(1)], [decision('delay', 2), decision('delay', 3), decision('skip', 4)]);
    assert.equal(s.delayCount, 2);
    assert.equal(s.skipCount, 1);
  });

  test('服从率 = 照做 / (照做 + 我判断不用)', () => {
    const s = stats([w(1)], [decision('confirm', 1), decision('confirm', 2), decision('watered', 3), decision('judged_no_need', 4)]);
    assert.equal(s.confirmCount, 3);
    assert.equal(s.judgedNoNeedCount, 1);
    assert.equal(s.adherenceRate, 0.75);
  });

  test('分母为 0 时服从率为 undefined', () => {
    assert.equal(stats([w(1)], []).adherenceRate, undefined);
  });

  test('区间外的决定不计入', () => {
    const s = stats([w(1)], [decision('delay', 40)], 7);
    assert.equal(s.delayCount, 0);
  });
});

describe('间隔趋势：样本太少不给结论', () => {
  test('少于 4 个间隔不给趋势', () => {
    const s = stats([w(0), w(5), w(10), w(15)]);
    assert.equal(s.intervalTrendDays, undefined, '3 个间隔算趋势是噪声');
  });

  test('间隔在拉长时趋势为正（早 2 天 → 近 9 天）', () => {
    // 记录按时间升序后，相邻间隔 = [7,6,4,3,2]，即间隔在收敛，趋势为负
    const s = stats([w(0), w(2), w(5), w(9), w(15), w(22)], [], 30);
    assert.equal(s.intervalTrendDays, -3.5, '间隔在变短，趋势应为负');
  });

  test('间隔在收敛时趋势为负（早 7 天 → 近 2 天）', () => {
    // 相邻间隔 = [2,3,4,6,9]，间隔在拉长，趋势为正
    const s = stats([w(0), w(9), w(15), w(19), w(22), w(24)], [], 30);
    assert.equal(s.intervalTrendDays, 3.83, '间隔在变长，趋势应为正');
  });
});

describe('formatStat：样本不足不显示 0', () => {
  test('undefined 显示「样本不足」而不是 0', () => {
    assert.equal(formatStat(undefined), '样本不足');
  });

  test('0 是合法值，照常显示', () => {
    assert.equal(formatStat(0, { unit: ' 次' }), '0 次', '真的是 0 时必须显示 0');
  });

  test('小数保留一位，整数不带小数', () => {
    assert.equal(formatStat(9.33), '9.3');
    assert.equal(formatStat(9), '9');
  });
});

describe('口径可被引用', () => {
  test('导出与界面共用同一个口径名', () => {
    const s = stats([w(1)]);
    assert.equal(s.basis, STATS_BASIS);
    assert.match(s.basis, /已补全/, '口径必须写明排除了未补全记录');
  });
});
