/**
 * Today 页面批次分组（D-01：L 动作批次）。
 *
 * 这是本产品的核心交互决策：把 N 盆植物的 N 次独立判断，
 * 压成按建议类型聚合的少数几个批次。让 12 次决策变成 3 次。
 *
 * 两条设计约束：
 *   1. 同一批次内的植物，建议理由高度相似，因此共同依据只写一遍
 *      （D-01 草稿里「理由聚在批头，不重复 N 遍」）。
 *   2. 批次是建议的聚合，不是记录的聚合。用户点「全部浇完」之后
 *      产生的是 N 条独立的 WateringRecord，而不是一条批次记录。
 *      这与 D-13「Reminder 不等于 Record」一致。
 *
 * 批量操作是误伤重灾区，所以本文件只负责分组与理由归纳，
 * 不负责执行。执行路径在 vertical-slice.ts 的 recordWatering(entrySource: 'bulk')。
 */

import type { Action, Plant, Recommendation } from '../domain/types.js';

/**
 * 批次分组只需要建议的这几项，不要求完整的 Recommendation 实体。
 * 引擎输出（尚未落库）也能直接用，避免为了分组而先写库。
 */
export type RecommendationView = Pick<Recommendation, 'action' | 'confidence' | 'reasons' | 'suggestedAction' | 'basedOn'> & { plantId: string };

/** 批次的稳定标识。不要用数组下标，界面要用它做 key 和筛选 */
export const BATCH_KINDS = ['water_now', 'check', 'delay', 'no_action'] as const;
export type BatchKind = (typeof BATCH_KINDS)[number];

/** 动作到批次的映射。写死成穷举，新增 Action 时编译期报错 */
export const ACTION_TO_BATCH: Record<Action, BatchKind> = {
  WATER_NOW: 'water_now',
  CHECK: 'check',
  DELAY: 'delay',
  NO_ACTION: 'no_action',
};

export const BATCH_META: Record<BatchKind, { title: string; hint: string; actionable: boolean }> = {
  water_now: { title: '今天浇水', hint: '点「全部浇完」只记时间，水量与方式可以之后再补', actionable: true },
  check: { title: '先看盆土', hint: '已进周期但还谈不上该浇，先确认盆土再说', actionable: true },
  delay: { title: '建议延后', hint: '近期有雨，延后 1 到 2 天', actionable: true },
  no_action: { title: '无需处理', hint: '暂时不用管', actionable: false },
};

export interface BatchItem {
  plant: Plant;
  recommendation: RecommendationView;
  /** 距上次浇水的天数，没有记录时为 undefined */
  daysSince: number | undefined;
  /** 该盆的周期文案，如「9 天 / 7-10 天」 */
  intervalText: string;
}

export interface Batch {
  kind: BatchKind;
  title: string;
  hint: string;
  items: BatchItem[];
  /** 批次的共同依据，界面显示一次而非每盆一次 */
  commonReasons: string[];
  /** 共同依据的可追溯来源，界面必须能显示「来源：…」 */
  commonSourceIds: string[];
  /** 该批次里信心最低的数值，界面用它显示「信心 中高」 */
  minConfidence: number;
}

export interface TodayBoard {
  batches: Batch[];
  /** 今日需要处理的盆数：water_now + check + delay */
  attentionCount: number;
  /** 天气是否不可用，界面必须显式提示 */
  weatherUnavailable: boolean;
}

/**
 * 从一批建议生成 Today 页面数据。
 *
 * 输入的顺序即批次的展示顺序；批内按信心从高到低排，
 * 让用户最该处理的排在最上面。
 */
export function buildTodayBoard(
  entries: { plant: Plant; recommendation: RecommendationView; daysSince: number | undefined }[],
  weatherUnavailable: boolean,
): TodayBoard {
  const grouped = new Map<BatchKind, BatchItem[]>();
  for (const k of BATCH_KINDS) grouped.set(k, []);

  for (const e of entries) {
    const kind = ACTION_TO_BATCH[e.recommendation.action];
    grouped.get(kind)?.push({
      plant: e.plant,
      recommendation: e.recommendation,
      daysSince: e.daysSince,
      intervalText: formatInterval(e.daysSince),
    });
  }

  const batches: Batch[] = [];
  for (const kind of BATCH_KINDS) {
    const items = grouped.get(kind) ?? [];
    if (items.length === 0) continue;
    items.sort((a, b) => b.recommendation.confidence - a.recommendation.confidence);
    const meta = BATCH_META[kind];

    batches.push({
      kind,
      title: meta.title,
      hint: meta.hint,
      items,
      commonReasons: commonReasons(items),
      commonSourceIds: commonSourceIds(items),
      minConfidence: Math.min(...items.map((i) => i.recommendation.confidence)),
    });
  }

  const attentionCount = batches
    .filter((b) => b.kind !== 'no_action')
    .reduce((sum, b) => sum + b.items.length, 0);

  return { batches, attentionCount, weatherUnavailable };
}

/**
 * 周期文案。没有浇水记录时明说「尚无记录」，
 * 不显示 0 天，也不按品种默认周期编一个数字出来（D-11）。
 */
function formatInterval(days: number | undefined): string {
  if (days === undefined) return '尚无记录';
  return `${days} 天`;
}

/**
 * 归纳批次的共同依据。
 *
 * 只保留「本批每一条都命中」的依据。若某条依据只对个别植物成立
 * （例如「你上次记录时自述低于湿度下限」），它属于个体情况，
 * 留在各自的详情里，不上批头。
 */
function commonReasons(items: BatchItem[]): string[] {
  if (items.length === 0) return [];
  const first = items[0];
  if (!first) return [];

  // 用 sourceId 做集合交集：只有所有植物都引用了同一条依据，才算共同依据
  const perItem = items.map((i) => new Map(i.recommendation.reasons.map((r) => [r.sourceId, r])));
  const common: string[] = [];
  for (const reason of first.recommendation.reasons) {
    if (perItem.every((m) => m.has(reason.sourceId))) {
      common.push(reason.text);
    }
  }
  return common;
}

function commonSourceIds(items: BatchItem[]): string[] {
  if (items.length === 0) return [];
  const first = items[0];
  if (!first) return [];
  const perItem = items.map((i) => new Set(i.recommendation.reasons.map((r) => r.sourceId)));
  const out: string[] = [];
  for (const r of first.recommendation.reasons) {
    if (perItem.every((s) => s.has(r.sourceId))) out.push(r.sourceId);
  }
  return out;
}

/** 批次的可执行性：no_action 不可批量操作，界面上不显示按钮 */
export function isBatchActionable(kind: BatchKind): boolean {
  return BATCH_META[kind].actionable;
}
