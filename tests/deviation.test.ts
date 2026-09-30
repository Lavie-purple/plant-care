/**
 * 偏差条带计算测试。
 *
 * 这些数字决定用户看到「该浇了」还是「还早」，
 * 几何必须可断言，不能只靠肉眼看条带画对没有。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_SAMPLES_FOR_JUDGEMENT,
  computeDeviation,
  isJudgementReliable,
} from '../src/app/deviation.js';
import type { CareRule, Plant, WateringRecord } from '../src/domain/types.js';

const TODAY = new Date('2026-09-30T14:32:00+08:00');

function plant(over: Partial<Plant> = {}): Plant {
  return { id: 'p1', name: '龟背竹 A', placement: '客厅', exposure: 'indoor_window', tags: [], createdAt: '', updatedAt: '', version: 1, ...over };
}

function rule(over: Partial<CareRule> = {}): CareRule {
  return { id: 'r1', plantId: 'p1', recommendedIntervalMin: 7, recommendedIntervalMax: 10, minimumInterval: 5, maximumInterval: 13, source: 'user', userOverride: true, updatedAt: '', version: 1, ...over };
}

function w(daysAgo: number, over: Partial<WateringRecord> = {}): WateringRecord {
  const d = new Date(TODAY);
  d.setDate(d.getDate() - daysAgo);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return {
    id: `w-${daysAgo}`, plantId: 'p1', date: `${d.getFullYear()}-${m}-${day}`, time: '14:00',
    amountMl: 500, amountSource: 'user_stated', method: '浇透', fertilizerIncluded: false, images: [],
    completionState: 'complete', entrySource: 'single',
    createdAt: '', updatedAt: '', version: 1, ...over,
  };
}

describe('状态判定：标记落在窗口哪一侧', () => {
  test('超过上限 → 已超期 → WATER_NOW', () => {
    const d = computeDeviation({ plant: plant(), rule: rule(), history: [w(12)], today: TODAY });
    assert.equal(d.status, 'overdue');
    assert.equal(d.suggestedAction, 'WATER_NOW');
    assert.equal(d.daysSince, 12);
  });

  test('落在窗口内 → 快到了 → CHECK', () => {
    const d = computeDeviation({ plant: plant(), rule: rule(), history: [w(8)], today: TODAY });
    assert.equal(d.status, 'window');
    assert.equal(d.suggestedAction, 'CHECK');
  });

  test('未到下限 → 还早 → NO_ACTION', () => {
    const d = computeDeviation({ plant: plant(), rule: rule(), history: [w(3)], today: TODAY });
    assert.equal(d.status, 'too_early');
    assert.equal(d.suggestedAction, 'NO_ACTION');
  });

  test('从未浇过 → 先看盆土，不是「还早」', () => {
    const d = computeDeviation({ plant: plant(), rule: rule(), history: [], today: TODAY });
    assert.equal(d.status, 'no_record');
    assert.equal(d.daysSince, null);
    assert.equal(d.suggestedAction, 'CHECK');
  });

  test('没设周期时画不出窗口，明确标注', () => {
    const d = computeDeviation({ plant: plant(), rule: undefined, history: [w(5)], today: TODAY });
    assert.equal(d.status, 'no_rule');
    assert.equal(d.basis, 'insufficient');
  });

  test('边界：正好等于上限算已超期', () => {
    const d = computeDeviation({ plant: plant(), rule: rule(), history: [w(10)], today: TODAY });
    assert.equal(d.status, 'overdue');
  });

  test('边界：正好等于下限算窗口内', () => {
    const d = computeDeviation({ plant: plant(), rule: rule(), history: [w(7)], today: TODAY });
    assert.equal(d.status, 'window');
  });
});

describe('几何：位置能对上', () => {
  test('窗口与标记都在 0-100 之间', () => {
    const d = computeDeviation({ plant: plant(), rule: rule(), history: [w(5)], today: TODAY });
    for (const v of [d.windowStart, d.windowEnd, d.markPosition]) {
      assert.ok(v >= 0 && v <= 100, `位置 ${v} 越界`);
    }
  });

  test('超期时标记在窗口右侧', () => {
    const d = computeDeviation({ plant: plant(), rule: rule(), history: [w(14)], today: TODAY });
    assert.ok(d.markPosition > d.windowEnd, `标记 ${d.markPosition} 应该在窗口右缘 ${d.windowEnd} 之外`);
  });

  test('还早时标记在窗口左侧', () => {
    const d = computeDeviation({ plant: plant(), rule: rule(), history: [w(2)], today: TODAY });
    assert.ok(d.markPosition < d.windowStart, `标记 ${d.markPosition} 应该在窗口左缘 ${d.windowStart} 之前`);
  });

  test('跨度留了缓冲，超期不会顶到边缘被裁掉', () => {
    const d = computeDeviation({ plant: plant(), rule: rule({ recommendedIntervalMax: 10 }), history: [w(30)], today: TODAY });
    assert.ok(d.spanDays > 10, `跨度 ${d.spanDays} 必须大于周期上限 10，否则超期标记看不到`);
  });

  test('窗口宽度反映周期差值', () => {
    const narrow = computeDeviation({ plant: plant(), rule: rule({ recommendedIntervalMin: 9, recommendedIntervalMax: 10 }), history: [w(5)], today: TODAY });
    const wide = computeDeviation({ plant: plant(), rule: rule({ recommendedIntervalMin: 3, recommendedIntervalMax: 14 }), history: [w(5)], today: TODAY });
    const nw = narrow.windowEnd - narrow.windowStart;
    const ww = wide.windowEnd - wide.windowStart;
    assert.ok(ww > nw, '周期跨度大的，窗口应画得更宽');
  });
});

describe('可靠性：样本不够就别下结论', () => {
  test('少于 3 次记录时判定不可靠', () => {
    const d = computeDeviation({ plant: plant(), rule: rule(), history: [w(5), w(15)], today: TODAY });
    assert.equal(d.sampleCount, 2);
    assert.equal(isJudgementReliable(d), false);
  });

  test('达到 3 次记录后可下结论', () => {
    const d = computeDeviation({ plant: plant(), rule: rule(), history: [w(5), w(15), w(25)], today: TODAY });
    assert.equal(isJudgementReliable(d), true);
    assert.equal(MIN_SAMPLES_FOR_JUDGEMENT, 3);
  });

  test('没设周期时永远不可靠', () => {
    const d = computeDeviation({ plant: plant(), rule: undefined, history: [w(5), w(15), w(25)], today: TODAY });
    assert.equal(isJudgementReliable(d), false);
  });

  test('待补全的记录不计入样本', () => {
    const d = computeDeviation({ plant: plant(), rule: rule(), history: [w(5), w(15), w(25, { completionState: 'pending' })], today: TODAY });
    assert.equal(d.sampleCount, 2, '未补全的记录不算真实浇水');
  });
});

describe('跨植物可比：同一时间尺度', () => {
  test('不同周期的植物用各自的跨度，但都从左起算', () => {
    const a = computeDeviation({ plant: plant({ id: 'a' }), rule: rule({ recommendedIntervalMax: 10 }), history: [w(5)], today: TODAY });
    const b = computeDeviation({ plant: plant({ id: 'b' }), rule: rule({ recommendedIntervalMax: 30 }), history: [w(5)], today: TODAY });
    // 5 天在两个尺度上占比不同，这是对的：周期不同不能直接比绝对位置
    assert.notEqual(a.markPosition, b.markPosition);
    // 但都从 0 开始（都是 5 天 / 各自跨度）
    assert.ok(a.markPosition > 0 && b.markPosition > 0);
  });
});
