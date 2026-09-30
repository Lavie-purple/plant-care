/**
 * 偏差条带的计算（I 方案）。
 *
 * 一行 = 一株植物，横向是时间。上面的虚线框是推荐的浇水窗口，
 * 实心条是「距上次浇水已经过了多少天」，右端竖线是今天。
 * 今天的标记落在窗口哪一侧，就是这株植物的状态。
 *
 * 为什么要单独抽出来：几何和判定必须可断言，
 * 不能只靠肉眼看条带画对没有。
 */

import type { Action, CareRule, Plant, WateringRecord } from '../domain/types.js';

export interface DeviationInput {
  plant: Plant;
  rule?: CareRule | undefined;
  /** 已完成的浇水记录，倒序或正序都行 */
  history: WateringRecord[];
  today: Date;
  /**
   * 条带显示的总天数，通常取「推荐周期上限 + 缓冲」，
   * 让所有植物的条带在同一时间尺度上，才好横向比较。
   */
  spanDays?: number;
}

export interface Deviation {
  plantId: string;
  name: string;
  placement: string;
  exposure: Plant['exposure'];
  /** 距上次浇水天数，null = 从未浇过 */
  daysSince: number | null;
  /** 推荐窗口的起止位置，百分比 0-100。null = 未设周期 */
  windowStart: number;
  windowEnd: number;
  /** 实心条的终点，百分比 0-100 */
  markPosition: number;
  /** 推荐周期上限，用于画轴 */
  spanDays: number;
  status: DeviationStatus;
  /** 建议动作，与今日养护页一致 */
  suggestedAction: Action;
  /** 采样数，界面要显示「还差几次才有结论」 */
  sampleCount: number;
  /** 判断可不可靠的依据来源 */
  basis: 'user_rule' | 'history_inferred' | 'insufficient';
}

export type DeviationStatus =
  | 'overdue' // 超过窗口上限，该浇了
  | 'window' // 落在窗口内，快到了
  | 'too_early' // 未到窗口下限
  | 'no_record' // 从未浇过
  | 'no_rule'; // 没设周期，画不出窗口

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

function recordDate(r: WateringRecord): Date {
  const [y, m, d] = r.date.split('-').map(Number);
  const [hh, mm] = r.time.split(':').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, hh ?? 12, mm ?? 0, 0, 0);
}

export function computeDeviation(input: DeviationInput): Deviation {
  const { plant, rule, today } = input;
  const completed = input.history
    .filter((r) => r.completionState === 'complete')
    .sort((a, b) => recordDate(b).getTime() - recordDate(a).getTime());

  const last = completed[0];
  const daysSince = last ? Math.max(0, daysBetween(recordDate(last), today)) : null;

  // 总跨度：至少覆盖到推荐上限，再留 40% 缓冲，
  // 这样「超期」的条能伸到窗口右侧而不是被裁掉。
  const upper = rule?.recommendedIntervalMax ?? 14;
  const spanDays = input.spanDays ?? Math.max(1, Math.ceil(upper * 1.4));

  const pct = (d: number) => Math.max(0, Math.min(100, (d / spanDays) * 100));

  if (!rule) {
    return {
      plantId: plant.id,
      name: plant.name,
      placement: plant.placement,
      exposure: plant.exposure,
      daysSince,
      windowStart: 0,
      windowEnd: 0,
      markPosition: pct(daysSince ?? 0),
      spanDays,
      status: 'no_rule',
      suggestedAction: daysSince === null ? 'CHECK' : 'CHECK',
      sampleCount: completed.length,
      basis: 'insufficient',
    };
  }

  const min = rule.recommendedIntervalMin;
  const max = rule.recommendedIntervalMax;
  const d = daysSince ?? 0;

  const status: DeviationStatus =
    daysSince === null ? 'no_record' : d >= max ? 'overdue' : d >= min ? 'window' : 'too_early';

  const suggestedAction: Action =
    status === 'overdue' ? 'WATER_NOW' : status === 'window' || status === 'no_record' ? 'CHECK' : 'NO_ACTION';

  return {
    plantId: plant.id,
    name: plant.name,
    placement: plant.placement,
    exposure: plant.exposure,
    daysSince,
    windowStart: pct(min),
    windowEnd: pct(max),
    markPosition: pct(d),
    spanDays,
    status,
    suggestedAction,
    sampleCount: completed.length,
    basis: 'user_rule',
  };
}

/**
 * 够不够看出「位置落在窗口哪一侧」。
 * 少于 3 次记录，位置只是噪声，不足以说明养护节奏。
 */
export const MIN_SAMPLES_FOR_JUDGEMENT = 3;

export function isJudgementReliable(d: Deviation): boolean {
  return d.basis === 'user_rule' && d.sampleCount >= MIN_SAMPLES_FOR_JUDGEMENT;
}

export const STATUS_LABEL: Record<DeviationStatus, string> = {
  overdue: '已超期',
  window: '窗口内',
  too_early: '还早',
  no_record: '尚无记录',
  no_rule: '未设周期',
};

/** 给整个页面用的一行短标签 */
export const STATUS_SHORT: Record<DeviationStatus, string> = {
  overdue: '该浇了',
  window: '快到了',
  too_early: '还早',
  no_record: '先看盆土',
  no_rule: '未设周期',
};
