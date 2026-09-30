/**
 * 导入导出测试。
 *
 * 最重要的一条：导入必须先校验再落库，任何一条记录不合法就整体拒绝。
 * 「导进去一半」比「导不进去」危险得多。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyImport,
  buildBundle,
  describeProblem,
  validateBundle,
  SCHEMA_VERSION,
  type ExportBundle,
  type ExportInput,
} from '../src/data/exportBundle.js';
import type { Plant, WateringRecord } from '../src/domain/types.js';

const NOW = new Date('2026-09-30T14:32:00+08:00');

function plant(id: string, name: string): Plant {
  return {
    id,
    name,
    placement: '客厅',
    exposure: 'indoor_window',
    tags: [],
    createdAt: '2026-09-01T10:00:00+08:00',
    updatedAt: '2026-09-01T10:00:00+08:00',
    version: 1,
  };
}

function watering(id: string, plantId: string): WateringRecord {
  return {
    id,
    plantId,
    date: '2026-09-28',
    time: '14:00',
    amountMl: 500,
    amountSource: 'user_provided_baseline',
    method: '浇透',
    fertilizerIncluded: false,
    images: [],
    completionState: 'complete',
    entrySource: 'single',
    createdAt: '2026-09-28T14:00:00+08:00',
    updatedAt: '2026-09-28T14:00:00+08:00',
    version: 1,
  };
}

function input(over: Partial<ExportInput> = {}): ExportInput {
  return {
    plants: [plant('p1', '龟背竹 A'), plant('p2', '薄荷')],
    careRules: [],
    wateringRecords: [watering('w1', 'p1')],
    plantEvents: [],
    weatherSnapshots: [],
    recommendations: [],
    pendingConflicts: [],
    decisionLogs: [],
    settings: [],
    images: [],
    now: NOW,
    ...over,
  };
}

function clone(b: ExportBundle): unknown {
  return JSON.parse(JSON.stringify(b));
}

describe('导出', () => {
  test('带版本号与导出时间', () => {
    const b = buildBundle(input());
    assert.equal(b.schemaVersion, SCHEMA_VERSION);
    assert.equal(b.exportedAt, NOW.toISOString());
  });

  test('统计各表条数', () => {
    const b = buildBundle(input());
    assert.equal(b.counts.plants, 2);
    assert.equal(b.counts.wateringRecords, 1);
  });

  test('时间由调用方注入，不读系统时钟', () => {
    const b = buildBundle(input({ now: new Date('2020-01-01T00:00:00Z') }));
    assert.equal(b.exportedAt, '2020-01-01T00:00:00.000Z');
  });

  test('往返后数据完全一致', () => {
    const b = buildBundle(input());
    const v = validateBundle(clone(b));
    assert.equal(v.ok, true);
    assert.deepEqual(v.bundle?.data.plants, b.data.plants);
    assert.deepEqual(v.bundle?.data.wateringRecords, b.data.wateringRecords);
  });
});

describe('导入校验：任何一条不合法就整体拒绝', () => {
  test('合法数据通过', () => {
    assert.equal(validateBundle(clone(buildBundle(input()))).ok, true);
  });

  test('顶层不是对象', () => {
    const v = validateBundle('这不是 JSON');
    assert.equal(v.ok, false);
    assert.equal(v.problems[0]?.kind, 'not_json');
  });

  test('JSON 语法错误', () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse('{坏掉的 JSON');
    } catch (e) {
      parsed = { __parseError: String(e) };
    }
    const v = validateBundle(parsed);
    assert.equal(v.ok, false);
  });

  test('版本号缺失 → 拒绝', () => {
    const raw = clone(buildBundle(input())) as Record<string, unknown>;
    delete raw.schemaVersion;
    const v = validateBundle(raw);
    assert.equal(v.ok, false);
    assert.equal(v.problems[0]?.kind, 'bad_schema_version');
  });

  test('版本号不匹配 → 拒绝，不做猜测迁移', () => {
    const raw = clone(buildBundle(input())) as Record<string, unknown>;
    raw.schemaVersion = 99;
    const v = validateBundle(raw);
    assert.equal(v.ok, false);
    assert.equal(v.problems[0]?.kind, 'bad_schema_version');
    assert.match(describeProblem(v.problems[0]!), /只认 1/);
  });

  test('缺必填字段 → 拒绝并指出是哪一条哪个字段', () => {
    const b = clone(buildBundle(input())) as { data: { plants: Record<string, unknown>[] } };
    delete b.data.plants[0]!.name;
    const v = validateBundle(b);
    assert.equal(v.ok, false);
    const p = v.problems.find((x) => x.kind === 'missing_field');
    assert.ok(p);
    assert.equal(p.store, 'plants');
    assert.equal(p.index, 0);
    assert.equal(p.field, 'name');
  });

  test('重复 id → 拒绝', () => {
    const b = clone(buildBundle(input())) as { data: { plants: Record<string, unknown>[] } };
    b.data.plants.push({ ...b.data.plants[0]! });
    const v = validateBundle(b);
    assert.equal(v.ok, false);
    assert.ok(v.problems.some((x) => x.kind === 'duplicate_id'));
  });

  test('引用不存在的植物 → 拒绝（悬挂引用）', () => {
    const b = clone(buildBundle(input())) as ExportBundle;
    b.data.wateringRecords[0]!.plantId = 'ghost';
    const v = validateBundle(b);
    assert.equal(v.ok, false);
    const p = v.problems.find((x) => x.kind === 'dangling_reference');
    assert.ok(p, '悬挂引用必须被挡住，否则导入后统计会静默出错');
    assert.equal(p.ref, 'ghost');
  });

  test('拒绝时不给 bundle，避免误用', () => {
    const raw = clone(buildBundle(input())) as Record<string, unknown>;
    raw.schemaVersion = 99;
    const v = validateBundle(raw);
    assert.equal(v.ok, false);
    assert.equal(v.bundle, undefined, '校验不通过时不得返回可用的 bundle');
  });

  test('校验通过时给出摘要供界面预览', () => {
    const v = validateBundle(clone(buildBundle(input())));
    assert.equal(v.ok, true);
    assert.equal(v.summary.plants, 2);
    assert.equal(v.summary.wateringRecords, 1);
  });
});

describe('合并策略', () => {
  const incoming = buildBundle(input({ now: NOW }));

  test('merge：同 id 跳过，不覆盖现有数据', () => {
    const existing = {
      plants: [plant('p1', '我的龟背竹（改过名）')],
      careRules: [],
      wateringRecords: [],
      plantEvents: [],
      weatherSnapshots: [],
      recommendations: [],
      pendingConflicts: [],
      decisionLogs: [],
      settings: [],
    };
    const r = applyImport(incoming, existing, 'merge');
    const p1 = r.bundle.data.plants.find((x) => x.id === 'p1');
    assert.equal(p1?.name, '我的龟背竹（改过名）', 'merge 不得覆盖用户现有数据');
    assert.equal(r.skipped.length, 1);
    assert.ok(r.skipped[0]?.id === 'p1');
  });

  test('merge：新 id 会被加入', () => {
    const empty = {
      plants: [], careRules: [], wateringRecords: [], plantEvents: [],
      weatherSnapshots: [], recommendations: [], pendingConflicts: [], decisionLogs: [], settings: [],
    };
    const r = applyImport(incoming, empty, 'merge');
    assert.equal(r.bundle.data.plants.length, 2);
    assert.equal(r.skipped.length, 0);
    assert.equal(r.added.plants, 2);
  });

  test('merge 后各类条数正确累加', () => {
    const existing = {
      plants: [plant('p1', 'A'), plant('p9', 'B')],
      careRules: [], wateringRecords: [watering('w1', 'p1'), watering('w9', 'p9')],
      plantEvents: [], weatherSnapshots: [], recommendations: [],
      pendingConflicts: [], decisionLogs: [], settings: [],
    };
    const r = applyImport(incoming, existing, 'merge');
    assert.equal(r.bundle.data.plants.length, 3, '现有 2 盆 + 导入新增 1 盆');
    // 导入只带 w1，而 w1 已存在被跳过，所以浇水记录仍是 2 条
    assert.equal(r.bundle.data.wateringRecords.length, 2);
    assert.deepEqual(
      r.bundle.data.plants.map((x) => x.id),
      ['p1', 'p9', 'p2'],
    );
  });

  test('replace：完全替换，用于恢复到某个备份', () => {
    const existing = {
      plants: [plant('p1', 'A'), plant('p9', 'B')],
      careRules: [], wateringRecords: [], plantEvents: [],
      weatherSnapshots: [], recommendations: [], pendingConflicts: [], decisionLogs: [], settings: [],
    };
    const r = applyImport(incoming, existing, 'replace');
    assert.equal(r.bundle.data.plants.length, 2, 'replace 后只剩导入的数据');
    assert.equal(r.bundle.data.plants.find((x) => x.id === 'p9'), undefined);
  });

  test('settings 按 city 去重', () => {
    const withSettings = buildBundle(
      input({
        settings: [
          {
            city: '广州', latitude: 23.11667, longitude: 113.25, timezone: 'Asia/Shanghai',
            weatherRefreshMinutes: 30, pendingCompletionDays: 14,
            baselinePotDiameterCm: 18, baselineWaterMl: 500, autoFollowConflicts: false, updatedAt: '2026-09-30T00:00:00+08:00',
          },
        ],
      }),
    );
    const existing = {
      plants: [], careRules: [], wateringRecords: [], plantEvents: [], weatherSnapshots: [],
      recommendations: [], pendingConflicts: [], decisionLogs: [],
      settings: [
        {
          city: '广州', latitude: 1, longitude: 2, timezone: 'Asia/Shanghai',
          weatherRefreshMinutes: 60, pendingCompletionDays: 14,
          baselinePotDiameterCm: 18, baselineWaterMl: 500, autoFollowConflicts: false, updatedAt: '2026-09-29T00:00:00+08:00',
        },
      ],
    };
    const r = applyImport(withSettings, existing, 'merge');
    assert.equal(r.bundle.data.settings.length, 1, '同 city 只保留一份');
    assert.equal(r.bundle.data.settings[0]?.weatherRefreshMinutes, 60, 'merge 保留用户现有设置');
  });
});

describe('问题描述可读', () => {
  test('每种问题都能转成人话', () => {
    const msgs = [
      { kind: 'not_json', detail: 'data 字段缺失' },
      { kind: 'bad_schema_version', found: 99, expected: 1 },
      { kind: 'missing_field', store: 'plants', index: 0, field: 'name' },
      { kind: 'duplicate_id', store: 'plants', id: 'p1' },
      { kind: 'dangling_reference', store: 'wateringRecords', index: 2, field: 'plantId', ref: 'ghost' },
    ] as const;
    for (const m of msgs) {
      const s = describeProblem(m);
      assert.ok(s.length > 0, `${m.kind} 必须有可读描述`);
      assert.doesNotMatch(s, /undefined/, `${m.kind} 的描述里不该出现 undefined`);
    }
  });
});
