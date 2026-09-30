/**
 * 批次分组测试。
 *
 * D-01 的核心：把 N 次决策压成 3 次。这是可断言的规则，不是审美偏好。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION_TO_BATCH,
  BATCH_KINDS,
  buildTodayBoard,
  isBatchActionable,
  type BatchKind,
} from '../src/app/batches.js';
import type { Action, Plant, Recommendation } from '../src/domain/types.js';

function plant(id: string, name = id): Plant {
  return {
    id,
    name,
    placement: '客厅',
    exposure: 'indoor_window',
    tags: [],
    createdAt: '',
    updatedAt: '',
    version: 1,
  };
}

function rec(
  id: string,
  action: Action,
  opts: { confidence?: number; reasonIds?: string[]; wateringCount?: number } = {},
): Recommendation {
  const reasonIds = opts.reasonIds ?? [`w-${id}`];
  return {
    id: `rec-${id}`,
    plantId: `plant-${id}`,
    generatedAt: '2026-09-30T14:32:00+08:00',
    action,
    confidence: opts.confidence ?? 0.75,
    reasons: reasonIds.map((sid) => ({
      text: `依据 ${sid}`,
      sourceId: sid,
      sourceKind: 'watering_record' as const,
      source: 'measured' as const,
    })),
    suggestedAction: '建议今天浇水，浇透。',
    basedOn: { wateringCount: opts.wateringCount ?? 1, weatherUnavailable: false },
    userConfirmed: false,
    version: 1,
  };
}

describe('动作到批次的映射是穷举的', () => {
  test('四档 Action 全部有对应批次', () => {
    assert.equal(ACTION_TO_BATCH.WATER_NOW, 'water_now');
    assert.equal(ACTION_TO_BATCH.CHECK, 'check');
    assert.equal(ACTION_TO_BATCH.DELAY, 'delay');
    assert.equal(ACTION_TO_BATCH.NO_ACTION, 'no_action');
  });

  test('每个批次都有标题和提示', () => {
    const board = buildTodayBoard([{ plant: plant('a'), recommendation: rec('a', 'WATER_NOW'), daysSince: 11 }], false);
    const b = board.batches[0];
    assert.ok(b);
    assert.ok(b.title.length > 0);
    assert.ok(b.hint.length > 0);
  });

  test('无需处理批次不可批量操作', () => {
    assert.equal(isBatchActionable('water_now'), true);
    assert.equal(isBatchActionable('check'), true);
    assert.equal(isBatchActionable('delay'), true);
    assert.equal(isBatchActionable('no_action'), false);
  });
});

describe('分组：把 N 次决策压成 3 次', () => {
  test('12 盆按动作聚合为 3 个可操作批次', () => {
    const entries = [
      ...Array.from({ length: 2 }, (_, i) => ({ plant: plant(`w${i}`), recommendation: rec(`w${i}`, 'WATER_NOW'), daysSince: 11 })),
      ...Array.from({ length: 3 }, (_, i) => ({ plant: plant(`c${i}`), recommendation: rec(`c${i}`, 'CHECK'), daysSince: 8 })),
      ...Array.from({ length: 4 }, (_, i) => ({ plant: plant(`d${i}`), recommendation: rec(`d${i}`, 'DELAY'), daysSince: 12 })),
      ...Array.from({ length: 3 }, (_, i) => ({ plant: plant(`n${i}`), recommendation: rec(`n${i}`, 'NO_ACTION'), daysSince: 2 })),
    ];
    const board = buildTodayBoard(entries, false);

    assert.equal(board.batches.length, 4, '四个非空批次');
    assert.equal(board.attentionCount, 9, '需处理 = 2+3+4，不含无需处理的 3 盆');
    const actionable = board.batches.filter((b) => isBatchActionable(b.kind));
    assert.equal(actionable.length, 3, '可操作批次正好 3 个');
  });

  test('批次按固定顺序展示，不随数据顺序变化', () => {
    const entries = [
      { plant: plant('n'), recommendation: rec('n', 'NO_ACTION'), daysSince: 2 },
      { plant: plant('d'), recommendation: rec('d', 'DELAY'), daysSince: 12 },
      { plant: plant('w'), recommendation: rec('w', 'WATER_NOW'), daysSince: 11 },
      { plant: plant('c'), recommendation: rec('c', 'CHECK'), daysSince: 8 },
    ];
    const board = buildTodayBoard(entries, false);
    assert.deepEqual(
      board.batches.map((b) => b.kind),
      ['water_now', 'check', 'delay', 'no_action'],
    );
  });

  test('空批次不占位', () => {
    const board = buildTodayBoard([{ plant: plant('w'), recommendation: rec('w', 'WATER_NOW'), daysSince: 11 }], false);
    assert.equal(board.batches.length, 1);
    assert.equal(board.batches[0]?.kind, 'water_now');
  });

  test('无数据时不产生空批次', () => {
    const board = buildTodayBoard([], false);
    assert.equal(board.batches.length, 0);
    assert.equal(board.attentionCount, 0);
  });

  test('批内按信心从高到低排', () => {
    const entries = [
      { plant: plant('low'), recommendation: rec('low', 'WATER_NOW', { confidence: 0.5 }), daysSince: 11 },
      { plant: plant('high'), recommendation: rec('high', 'WATER_NOW', { confidence: 0.9 }), daysSince: 11 },
      { plant: plant('mid'), recommendation: rec('mid', 'WATER_NOW', { confidence: 0.7 }), daysSince: 11 },
    ];
    const board = buildTodayBoard(entries, false);
    assert.deepEqual(
      board.batches[0]?.items.map((i) => i.plant.id),
      ['high', 'mid', 'low'],
    );
  });

  test('批次信心取批内最低值，不虚报', () => {
    const entries = [
      { plant: plant('a'), recommendation: rec('a', 'WATER_NOW', { confidence: 0.9 }), daysSince: 11 },
      { plant: plant('b'), recommendation: rec('b', 'WATER_NOW', { confidence: 0.4 }), daysSince: 11 },
    ];
    const board = buildTodayBoard(entries, false);
    assert.equal(board.batches[0]?.minConfidence, 0.4, '一批里有一盆没把握，整批就不该显示高信心');
  });
});

describe('共同依据：只归纳所有植物都命中的那些', () => {
  test('两盆引用同一天气快照时，天气依据上批头', () => {
    const entries = [
      { plant: plant('a'), recommendation: rec('a', 'WATER_NOW', { reasonIds: ['w-a', 'weather-1'] }), daysSince: 11 },
      { plant: plant('b'), recommendation: rec('b', 'WATER_NOW', { reasonIds: ['w-b', 'weather-1'] }), daysSince: 11 },
    ];
    const board = buildTodayBoard(entries, false);
    assert.deepEqual(board.batches[0]?.commonSourceIds, ['weather-1']);
    assert.equal(board.batches[0]?.commonReasons.length, 1);
  });

  test('依据各不相同则不归纳，批头为空', () => {
    const entries = [
      { plant: plant('a'), recommendation: rec('a', 'WATER_NOW', { reasonIds: ['w-a'] }), daysSince: 11 },
      { plant: plant('b'), recommendation: rec('b', 'WATER_NOW', { reasonIds: ['w-b'] }), daysSince: 11 },
    ];
    const board = buildTodayBoard(entries, false);
    assert.deepEqual(board.batches[0]?.commonSourceIds, []);
  });

  test('个别植物独有的依据不上批头（留各自详情）', () => {
    const entries = [
      { plant: plant('a'), recommendation: rec('a', 'WATER_NOW', { reasonIds: ['w-a', 'weather-1'] }), daysSince: 11 },
      { plant: plant('b'), recommendation: rec('b', 'WATER_NOW', { reasonIds: ['w-b'] }), daysSince: 11 },
    ];
    const board = buildTodayBoard(entries, false);
    assert.deepEqual(board.batches[0]?.commonSourceIds, [], '只有一盆命中的依据不算共同依据');
  });
});

describe('天气不可用必须显式传上来', () => {
  test('weatherUnavailable 透传给界面', () => {
    const entries = [{ plant: plant('a'), recommendation: rec('a', 'CHECK'), daysSince: 8 }];
    assert.equal(buildTodayBoard(entries, true).weatherUnavailable, true);
    assert.equal(buildTodayBoard(entries, false).weatherUnavailable, false);
  });
});

describe('无浇水记录时不编造天数', () => {
  test('daysSince 为 undefined 时显示「尚无记录」', () => {
    const entries = [{ plant: plant('new'), recommendation: rec('new', 'CHECK', { wateringCount: 0 }), daysSince: undefined }];
    const board = buildTodayBoard(entries, false);
    assert.equal(board.batches[0]?.items[0]?.intervalText, '尚无记录');
  });
});
