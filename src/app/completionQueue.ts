/**
 * 补录队列（D-06 X 方案）。
 *
 * 存在的理由：批量浇水是本产品效率最高的功能（一次点 N 盆），
 * 但要求用户当场填写 N 份完整表单是不可接受的。
 * 因此批量只记时间与方式，剩余字段进队列稍后补。
 *
 * 队列必须有终点。没有终点的话它会无限堆积，最后变成没人敢打开的垃圾场。
 * 终点规则：超过 pendingCompletionDays（默认 14 天）未补全的记录，
 * 自动降级为 expired（历史空白），水量记为未知，不再提示。
 * 这是「主动放弃」而不是「数据丢失」——记录仍在，统计数据只是不含它。
 */

import type { Plant, WateringMethod, WateringRecord } from '../domain/types.js';

export const DEFAULT_PENDING_DAYS = 14;

export interface QueueItem {
  record: WateringRecord;
  plant: Plant;
  /** 距今多少天。超过阈值应已被 sweep 降级，这里仍计算以防漏网 */
  daysWaiting: number;
  /** 距阈值过期还剩几天。<= 0 表示即将或已被降级 */
  daysUntilExpire: number;
  /** 已经补了哪些，界面据此决定要问什么 */
  needs: {
    amount: boolean;
    method: boolean;
    fertilizer: boolean;
    note: boolean;
  };
}

export interface QueueBuildInput {
  plants: Plant[];
  /** 全部植物的浇水记录，函数内部按 plantId 分组 */
  records: WateringRecord[];
  today: Date;
  pendingDays?: number;
}

function recordDate(r: WateringRecord): Date {
  const [y, m, d] = r.date.split('-').map(Number);
  const [hh, mm] = r.time.split(':').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0, 0, 0);
}

export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

/**
 * 哪些字段还需要补。
 * 只问真正缺的，不做一次性表单。
 */
export function missingFields(r: WateringRecord): QueueItem['needs'] {
  return {
    // 快速记录的记录带的是估算水量，只有用户手填才算补全
    amount: r.amountSource !== 'user_stated',
    // 快速记录会预设「浇透」，若方式与预设相同则不必再问
    method: !r.method,
    // 营养液默认 false 是「没加」，不是「不知道」，因此不算缺失
    fertilizer: false,
    note: !r.notes,
  };
}

/**
 * 构建待补全队列。
 * 顺序：最近记录在前。先补最近发生的，符合直觉。
 */
export function buildQueue(input: QueueBuildInput): QueueItem[] {
  const pendingDays = input.pendingDays ?? DEFAULT_PENDING_DAYS;
  const byPlant = new Map<string, Plant>();
  for (const p of input.plants) byPlant.set(p.id, p);

  return input.records
    .filter((r) => r.completionState === 'pending')
    .map((r) => {
      const daysWaiting = daysBetween(recordDate(r), input.today);
      return {
        record: r,
        plant: byPlant.get(r.plantId),
        daysWaiting,
        daysUntilExpire: pendingDays - daysWaiting,
        needs: missingFields(r),
      };
    })
    .filter((x): x is QueueItem & { plant: Plant } => Boolean(x.plant))
    .sort((a, b) => recordDate(b.record).getTime() - recordDate(a.record).getTime());
}

/**
 * 找出需要降级为「历史空白」的记录。
 * 纯函数，不改数据，调用方负责落库。这样规则可测且副作用明确。
 */
export function selectExpired(
  records: WateringRecord[],
  today: Date,
  pendingDays: number = DEFAULT_PENDING_DAYS,
): WateringRecord[] {
  return records
    .filter((r) => r.completionState === 'pending')
    .filter((r) => daysBetween(recordDate(r), today) >= pendingDays)
    .map((r) => ({ ...r, completionState: 'expired' as const, version: r.version + 1 }));
}

/**
 * 完成补录。
 *
 * 关键约束：补录时若用户没填水量，**不能**用估算值覆盖已有估算。
 * 已有估算 + 用户仍未填 = 保持估算，并显式标注来源。
 * 这与 D-13「用户手填优先于估算」一致。
 */
export interface CompleteInput {
  record: WateringRecord;
  amountMl?: number;
  method?: WateringMethod;
  fertilizerIncluded?: boolean;
  notes?: string;
  now: Date;
}

export function completeRecord(input: CompleteInput): WateringRecord {
  const { record } = input;
  const hasUserAmount = typeof input.amountMl === 'number' && input.amountMl > 0;

  return {
    ...record,
    completionState: 'complete',
    ...(hasUserAmount
      ? { amountMl: input.amountMl as number, amountSource: 'user_stated' as const }
      : {}),
    ...(input.method !== undefined ? { method: input.method } : {}),
    ...(input.fertilizerIncluded !== undefined ? { fertilizerIncluded: input.fertilizerIncluded } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    updatedAt: input.now.toISOString(),
    version: record.version + 1,
  };
}

/**
 * 队列摘要，给界面顶部的提示条用。
 * 不显示「全部已补全」以外的好消息，只给一个可执行的下一步。
 */
export function summarizeQueue(items: QueueItem[]): {
  total: number;
  /** 3 天内就会过期的条数，需要提醒 */
  expiringSoon: number;
  needsAmountOnly: number;
} {
  return {
    total: items.length,
    expiringSoon: items.filter((x) => x.daysUntilExpire <= 3).length,
    needsAmountOnly: items.filter((x) => x.needs.amount && !x.needs.method && !x.needs.note).length,
  };
}
