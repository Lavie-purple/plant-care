/**
 * 筛选测试。
 *
 * 九维筛选的口径必须唯一。界面上不得另立一套判断，
 * 所以这里把每条规则的边界都钉死。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION_ORDER,
  ATTENTION_ACTIONS,
  EMPTY_FILTERS,
  activeFilterCount,
  applyFilters,
  clearAll,
  matchesSearch,
  toggleInArray,
  type FilterablePlant,
  type FilterState,
} from '../src/app/filters.js';
import type { Action, Exposure, Plant } from '../src/domain/types.js';

let seq = 0;
function p(over: Partial<Plant> = {}): Plant {
  seq += 1;
  return {
    id: `p${seq}`,
    name: `植物 ${seq}`,
    placement: '客厅',
    exposure: 'indoor_window',
    tags: [],
    createdAt: '',
    updatedAt: '',
    version: 1,
    ...over,
  };
}

function item(plant: Plant, over: Partial<FilterablePlant> = {}): FilterablePlant {
  return {
    plant,
    action: undefined,
    daysSince: undefined,
    hasCareRule: false,
    maxInterval: undefined,
    wateringCount: 0,
    pendingCount: 0,
    ...over,
  };
}

const A = (f: Partial<FilterState>): FilterState => ({ ...EMPTY_FILTERS, ...f });

describe('搜索：任一字段包含即命中', () => {
  test('按名称', () => {
    assert.equal(matchesSearch(p({ name: '龟背竹 A' }), '龟背'), true);
    assert.equal(matchesSearch(p({ name: '龟背竹 A' }), '薄荷'), false);
  });

  test('按品种 / 科 / 属', () => {
    const x = p({ name: 'A', species: '龟背竹', family: '天南星科', genus: '龟背竹属' });
    assert.equal(matchesSearch(x, '天南星'), true);
    assert.equal(matchesSearch(x, '龟背竹属'), true);
  });

  test('按标签', () => {
    assert.equal(matchesSearch(p({ name: 'A', tags: ['大叶', '客厅绿植'] }), '大叶'), true);
  });

  test('英文大小写不敏感', () => {
    assert.equal(matchesSearch(p({ name: 'Monstera' }), 'monstera'), true);
  });

  test('空搜索词命中全部', () => {
    assert.equal(matchesSearch(p(), ''), true);
    assert.equal(matchesSearch(p(), '   '), true);
  });
});

describe('位置与暴露度：精确匹配', () => {
  const items = [
    item(p({ placement: '客厅', exposure: 'indoor_window' })),
    item(p({ placement: '阳台', exposure: 'outdoor' })),
    item(p({ placement: '卧室', exposure: 'indoor' })),
  ];

  test('按位置筛选', () => {
    const r = applyFilters(items, A({ placements: ['阳台'] }));
    assert.equal(r.length, 1);
    assert.equal(r[0]?.plant.placement, '阳台');
  });

  test('多选位置是并集', () => {
    const r = applyFilters(items, A({ placements: ['阳台', '卧室'] }));
    assert.equal(r.length, 2);
  });

  test('按暴露度筛选', () => {
    const r = applyFilters(items, A({ exposures: ['outdoor'] }));
    assert.equal(r.length, 1);
    assert.equal(r[0]?.plant.exposure, 'outdoor');
  });

  test('室内与靠窗是两个不同选项', () => {
    const all = [
      item(p({ exposure: 'indoor' })),
      item(p({ exposure: 'indoor_window' })),
    ];
    assert.equal(applyFilters(all, A({ exposures: ['indoor'] })).length, 1);
    assert.equal(applyFilters(all, A({ exposures: ['indoor', 'indoor_window'] })).length, 2);
  });
});

describe('状态筛选：按今天的建议动作', () => {
  const items = [
    item(p(), { action: 'WATER_NOW' }),
    item(p(), { action: 'CHECK' }),
    item(p(), { action: 'DELAY' }),
    item(p(), { action: 'NO_ACTION' }),
  ];

  test('四档各自可筛', () => {
    for (const a of ['WATER_NOW', 'CHECK', 'DELAY', 'NO_ACTION'] as Action[]) {
      const r = applyFilters(items, A({ actions: [a] }));
      assert.equal(r.length, 1, `${a} 应筛出 1 盆`);
    }
  });

  test('没有建议的植物不命中任何状态筛选', () => {
    const withNone = [...items, item(p())];
    const r = applyFilters(withNone, A({ actions: ['WATER_NOW'] }));
    assert.equal(r.length, 1, '没建议的不该被算进「今天浇水」');
  });

  test('「今天要处理」= 浇水 + 检查 + 延期，不含无需处理', () => {
    const r = applyFilters(items, A({ actions: ATTENTION_ACTIONS }));
    assert.equal(r.length, 3);
  });
});

describe('记录与规则筛选', () => {
  const items = [
    item(p(), { wateringCount: 5, pendingCount: 0, hasCareRule: true, maxInterval: 10, daysSince: 3 }),
    item(p(), { wateringCount: 0, pendingCount: 0, hasCareRule: false, daysSince: undefined }),
    item(p(), { wateringCount: 2, pendingCount: 1, hasCareRule: true, maxInterval: 7, daysSince: 12 }),
  ];

  test('有浇水记录', () => {
    assert.equal(applyFilters(items, A({ record: 'has_record' })).length, 2);
  });

  test('从未浇水', () => {
    assert.equal(applyFilters(items, A({ record: 'never_watered' })).length, 1);
  });

  test('有待补全', () => {
    assert.equal(applyFilters(items, A({ record: 'has_pending' })).length, 1);
  });

  test('有周期 / 无周期', () => {
    assert.equal(applyFilters(items, A({ rule: 'has_rule' })).length, 2);
    assert.equal(applyFilters(items, A({ rule: 'no_rule' })).length, 1);
  });

  test('已超期：超过各自上限才算', () => {
    const r = applyFilters(items, A({ rule: 'overdue' }));
    assert.equal(r.length, 1, '只有 12 天 > 上限 7 天那盆超期');
    assert.equal(r[0]?.daysSince, 12);
  });

  test('没规则的不算「已超期」', () => {
    const r = applyFilters(items, A({ rule: 'overdue' }));
    assert.equal(
      r.every((x) => x.hasCareRule),
      true,
      '无规则时无法判断超期，不应入选',
    );
  });
});

describe('多条件组合是交集', () => {
  const items = [
    item(p({ placement: '客厅', exposure: 'indoor_window' }), { action: 'WATER_NOW', wateringCount: 3 }),
    item(p({ placement: '客厅', exposure: 'outdoor' }), { action: 'WATER_NOW', wateringCount: 0 }),
    item(p({ placement: '阳台', exposure: 'outdoor' }), { action: 'CHECK', wateringCount: 5 }),
  ];

  test('位置 + 暴露度同时生效', () => {
    const r = applyFilters(items, A({ placements: ['客厅'], exposures: ['outdoor'] }));
    assert.equal(r.length, 1);
    assert.equal(r[0]?.plant.exposure, 'outdoor');
  });

  test('再加状态条件继续收窄', () => {
    const r = applyFilters(items, A({ placements: ['客厅'], exposures: ['outdoor'], actions: ['WATER_NOW'] }));
    assert.equal(r.length, 1);
  });

  test('条件互斥时结果为空，不能报错', () => {
    const r = applyFilters(items, A({ placements: ['阳台'], actions: ['WATER_NOW'] }));
    assert.deepEqual(r, []);
  });
});

describe('chip 辅助', () => {
  test('点一下加，再点一下去', () => {
    let a = toggleInArray<Action>([], 'CHECK');
    assert.deepEqual(a, ['CHECK']);
    a = toggleInArray(a, 'CHECK');
    assert.deepEqual(a, []);
  });

  test('不影响原数组', () => {
    const orig: Action[] = ['CHECK'];
    const next = toggleInArray(orig, 'DELAY');
    assert.deepEqual(orig, ['CHECK'], '原数组不应被改');
    assert.deepEqual(next, ['CHECK', 'DELAY']);
  });

  test('生效条数可显示给用户', () => {
    assert.equal(activeFilterCount(EMPTY_FILTERS), 0);
    assert.equal(activeFilterCount(A({ search: '龟背' })), 1);
    assert.equal(activeFilterCount(A({ search: '龟背', placements: ['客厅'], exposures: ['outdoor'] })), 3);
    assert.equal(activeFilterCount(A({ record: 'has_pending', rule: 'overdue' })), 2);
  });

  test('空搜索词不计入生效条数', () => {
    assert.equal(activeFilterCount(A({ search: '   ' })), 0);
  });

  test('一键清空', () => {
    const dirty = A({ search: 'x', placements: ['客厅'], actions: ['CHECK'] });
    assert.equal(activeFilterCount(clearAll()), 0);
    assert.equal(dirty.placements.length, 1, 'clearAll 返回新对象，不改原状态');
  });
});

describe('建议顺序：最该处理的在前', () => {
  test('浇水 < 检查 < 延期 < 无需处理', () => {
    const order = (['NO_ACTION', 'DELAY', 'CHECK', 'WATER_NOW'] as Action[]).sort(
      (a, b) => ACTION_ORDER[a] - ACTION_ORDER[b],
    );
    assert.deepEqual(order, ['WATER_NOW', 'CHECK', 'DELAY', 'NO_ACTION']);
  });
});
