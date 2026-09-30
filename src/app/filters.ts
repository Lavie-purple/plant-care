/**
 * 植物筛选（D-09 / spec 第 16 节）。
 *
 * 九个筛选维度里只有 4 个能常驻显示，其余收进「更多」抽屉。
 * 本文件只管筛选规则，不管界面；界面拿到的永远是筛完的结果。
 *
 * 维度口径（写死在这里，界面上不得另立一套）：
 *   搜索    名称 / 品种 / 科 / 属 / 标签，任一包含即命中
 *   位置    placement 精确匹配（D-10：位置是唯一枚举）
 *   暴露    indoor=室内，indoor_window=靠窗，semi_outdoor=半户外，outdoor=露天
 *   状态    今天这盆的建议动作，四档
 *   周期    有周期 / 无周期 / 已超期
 *   光照    lightProfile 精确匹配（D-02）
 *   记录    有浇水记录 / 从未浇水 / 有待补全
 */

import type { Exposure, LightProfile, Plant, Placement } from '../domain/types.js';
import type { Action } from '../domain/types.js';

export const EXPOSURE_FILTERS: { key: Exposure; label: string }[] = [
  { key: 'indoor_window', label: '靠窗' },
  { key: 'outdoor', label: '露天' },
  { key: 'semi_outdoor', label: '半户外' },
  { key: 'indoor', label: '室内' },
];

export const PLACEMENTS_FILTER: { key: Placement; label: string } = { key: '客厅', label: '客厅' };

export type RecordFilter = 'has_record' | 'never_watered' | 'has_pending';
export type RuleFilter = 'has_rule' | 'no_rule' | 'overdue';

export interface FilterState {
  search: string;
  placements: Placement[];
  exposures: Exposure[];
  actions: Action[];
  lightProfiles: LightProfile[];
  record: RecordFilter | null;
  rule: RuleFilter | null;
}

export const EMPTY_FILTERS: FilterState = {
  search: '',
  placements: [],
  exposures: [],
  actions: [],
  lightProfiles: [],
  record: null,
  rule: null,
};

export interface FilterablePlant {
  plant: Plant;
  /** 今天的建议动作，用于状态筛选。无建议时为 undefined */
  action: Action | undefined;
  daysSince: number | undefined;
  hasCareRule: boolean;
  /** 规则的上限周期，天。用于「已超期」判定。无规则时为 undefined */
  maxInterval: number | undefined;
  wateringCount: number;
  pendingCount: number;
}

/** 归一化搜索词：去空白、转小写，中英文都适用 */
function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** 某株植物在给定搜索词下是否命中 */
export function matchesSearch(plant: Plant, search: string): boolean {
  const q = norm(search);
  if (!q) return true;
  const haystack = [plant.name, plant.species, plant.family, plant.genus, plant.notes, ...plant.tags]
    .filter((x): x is string => typeof x === 'string')
    .map(norm);
  return haystack.some((h) => h.includes(q));
}

export function applyFilters(items: FilterablePlant[], f: FilterState): FilterablePlant[] {
  return items.filter((it) => {
    if (!matchesSearch(it.plant, f.search)) return false;
    if (f.placements.length > 0 && !f.placements.includes(it.plant.placement)) return false;
    if (f.exposures.length > 0 && !f.exposures.includes(it.plant.exposure)) return false;
    if (f.lightProfiles.length > 0) {
      const lp = it.plant.lightProfile;
      if (!lp || !f.lightProfiles.includes(lp)) return false;
    }
    if (f.actions.length > 0) {
      if (!it.action || !f.actions.includes(it.action)) return false;
    }
    if (f.record === 'has_record' && it.wateringCount === 0) return false;
    if (f.record === 'never_watered' && it.wateringCount > 0) return false;
    if (f.record === 'has_pending' && it.pendingCount === 0) return false;
    if (f.rule === 'has_rule' && !it.hasCareRule) return false;
    if (f.rule === 'no_rule' && it.hasCareRule) return false;
    if (f.rule === 'overdue') {
      // 「已超期」需要规则和记录同时存在，缺一不可
      if (!it.hasCareRule || it.daysSince === undefined) return false;
      if (it.daysSince < maxIntervalOf(it)) return false;
    }
    return true;
  });
}

/**
 * 取这株植物的推荐周期上限。
 * 规则存在时用规则上限，否则无解，返回 Infinity 表示「无法判断超期」。
 * 放在这里而不是让调用方传，是为了让 overdue 口径只有一处。
 */
function maxIntervalOf(it: FilterablePlant): number {
  return it.maxInterval ?? Infinity;
}

/** 当前生效的筛选条数。界面用它显示「已选 N 项」 */
export function activeFilterCount(f: FilterState): number {
  return (
    (f.search.trim() ? 1 : 0) +
    f.placements.length +
    f.exposures.length +
    f.actions.length +
    f.lightProfiles.length +
    (f.record ? 1 : 0) +
    (f.rule ? 1 : 0)
  );
}

/** 增删一个数组型筛选项。点一下切换，符合 chip 的直觉 */
export function toggleInArray<T>(arr: T[], value: T): T[] {
  return arr.includes(value) ? arr.filter((x) => x !== value) : [...arr, value];
}

export function clearAll(): FilterState {
  return { ...EMPTY_FILTERS };
}

/**
 * 「今天要处理」的快捷筛选：只看需要动手的，不含无需处理。
 * 这是首页与植物页之间最常用的跳转，必须口径唯一。
 */
export const ATTENTION_ACTIONS: Action[] = ['WATER_NOW', 'CHECK', 'DELAY'];

/** 按批次的建议顺序排序植物墙，最该处理的在前 */
export const ACTION_ORDER: Record<Action, number> = {
  WATER_NOW: 0,
  CHECK: 1,
  DELAY: 2,
  NO_ACTION: 3,
};
