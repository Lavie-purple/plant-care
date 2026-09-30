/**
 * 养护统计。
 *
 * 这些数字会被用户当依据用（调整周期、判断自己是否浇太多），
 * 所以口径必须唯一且可断言。AGENTS.md：禁止核心概念有多个口径。
 *
 * 口径声明（所有窗口与导出都注明此口径名）：
 *   - 统计区间按「今天往前 N 天」，含今天，不含未来
 *   - 只统计 completionState = 'complete' 的记录，未补全的不算
 *   - 「平均水量」只统计用户手填过水量的记录，估算值单独一栏
 *   - 延期次数来自决定日志，不来自 watering records
 */

import type { DecisionLog, UserAction, WateringRecord } from '../domain/types.js';

/** 口径名，界面与导出文件里都要写明 */
export const STATS_BASIS = '近 N 天（今天往前，含今天，不含未来；仅统计已补全的浇水记录）';

export type Range = 7 | 30 | 90 | 365;

export interface WateringStats {
  range: Range;
  /** 区间内的浇水次数 */
  wateringCount: number;
  /** 平均浇水间隔，天。样本 < 2 时为 undefined，不编造 */
  averageIntervalDays: number | undefined;
  /** 平均间隔的中位数，用于抗异常值。样本 < 2 时为 undefined */
  medianIntervalDays: number | undefined;
  /** 用户手填的水量均值，ml。只有填过水量的记录才计入 */
  averageAmountMl: number | undefined;
  /** 有多少条记录是估算水量 */
  estimatedAmountCount: number;
  /** 实际参与水量统计的样本数。界面必须显示这个分母 */
  amountSampleCount: number;
  /** 延期次数，来自决定日志 */
  delayCount: number;
  /** 跳过次数，来自决定日志 */
  skipCount: number;
  /** 「我判断不用浇」次数。这是学习闭环的关键信号 */
  judgedNoNeedCount: number;
  /** 「照做」次数，用于算服从率 */
  confirmCount: number;
  /** 服从率 = confirm / (confirm + judgedNoNeed)。分母为 0 时 undefined */
  adherenceRate: number | undefined;
  /** 间隔趋势：后半段均值 - 前半段均值，正数表示间隔在变长 */
  intervalTrendDays: number | undefined;
  /** 逐次间隔，用于画趋势 */
  intervals: number[];
  /** 口径说明，导出时一并写入 */
  basis: string;
}

export interface StatsInput {
  history: WateringRecord[];
  decisions: DecisionLog[];
  today: Date;
  range: Range;
}

/** 把 ISO 日期解析为本地时刻。不走 UTC 截断（D-15）。 */
function parseDate(date: string, time = '12:00'): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, hh ?? 12, mm ?? 0, 0, 0);
}

export function computeStats(input: StatsInput): WateringStats {
  const { range, today } = input;
  const from = new Date(today);
  from.setDate(from.getDate() - (range - 1));
  from.setHours(0, 0, 0, 0);

  const inRange = input.history
    .filter((w) => w.completionState === 'complete')
    .filter((w) => parseDate(w.date, w.time).getTime() >= from.getTime())
    .sort((a, b) => parseDate(a.date, a.time).getTime() - parseDate(b.date, b.time).getTime());

  const intervals: number[] = [];
  for (let i = 1; i < inRange.length; i += 1) {
    const prev = inRange[i - 1];
    const cur = inRange[i];
    if (!prev || !cur) continue;
    const days = Math.round(
      (parseDate(cur.date, cur.time).getTime() - parseDate(prev.date, prev.time).getTime()) / 86_400_000,
    );
    if (days > 0) intervals.push(days);
  }

  // 水量：只算用户手填的，估算值单独计数
  const stated = inRange.filter((w) => w.amountSource === 'user_stated' && typeof w.amountMl === 'number');
  const estimated = inRange.filter((w) => w.amountSource === 'user_provided_baseline');

  const decisions = input.decisions.filter((d) => parseDate(d.userConfirmedAt.slice(0, 10)).getTime() >= from.getTime());
  const countAction = (a: UserAction) => decisions.filter((d) => d.action === a).length;

  const confirmCount = countAction('confirm') + countAction('watered');
  const judgedNoNeedCount = countAction('judged_no_need');
  const adherenceDenominator = confirmCount + judgedNoNeedCount;

  return {
    range,
    wateringCount: inRange.length,
    averageIntervalDays: mean(intervals),
    medianIntervalDays: median(intervals),
    averageAmountMl: mean(stated.map((w) => w.amountMl as number)),
    estimatedAmountCount: estimated.length,
    amountSampleCount: stated.length,
    delayCount: countAction('delay'),
    skipCount: countAction('skip'),
    judgedNoNeedCount,
    confirmCount,
    adherenceRate: adherenceDenominator > 0 ? round2(confirmCount / adherenceDenominator) : undefined,
    intervalTrendDays: trend(intervals),
    intervals,
    basis: STATS_BASIS,
  };
}

function mean(nums: number[]): number | undefined {
  if (nums.length === 0) return undefined;
  const s = nums.reduce((a, b) => a + b, 0);
  return round2(s / nums.length);
}

function median(nums: number[]): number | undefined {
  if (nums.length === 0) return undefined;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 0) {
    const a = s[mid - 1];
    const b = s[mid];
    if (a !== undefined && b !== undefined) return round2((a + b) / 2);
    return undefined;
  }
  const v = s[mid];
  return v === undefined ? undefined : round2(v);
}

/**
 * 间隔趋势：后半段均值 - 前半段均值。
 * 样本少于 4 个不给趋势，单点差异没有意义。
 */
function trend(intervals: number[]): number | undefined {
  if (intervals.length < 4) return undefined;
  const half = Math.floor(intervals.length / 2);
  const front = mean(intervals.slice(0, half));
  const back = mean(intervals.slice(half));
  if (front === undefined || back === undefined) return undefined;
  return round2(back - front);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 界面上显示统计值的统一格式。
 * 样本不足时明说「样本不足」，不显示 0，避免把「没有数据」误读成「结果是 0」。
 */
export function formatStat(
  value: number | undefined,
  opts: { unit?: string; decimals?: number; insufficientLabel?: string } = {},
): string {
  if (value === undefined) return opts.insufficientLabel ?? '样本不足';
  const d = opts.decimals ?? (Number.isInteger(value) ? 0 : 1);
  return `${value.toFixed(d)}${opts.unit ?? ''}`;
}
