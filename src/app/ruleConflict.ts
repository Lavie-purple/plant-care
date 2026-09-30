/**
 * 规则冲突（D-13 铁律的执行点）。
 *
 * 引擎算出「按这个天气，周期该是 7 天」，而你设的是 10 天。
 * 系统**不能**自己改。它只能：
 *   1. 记一条 PendingRuleConflict
 *   2. 问你一次
 *   3. 你选保持还是改
 *
 * 三个必须守住的不变量：
 *   - 同一个冲突只问一次（W3：连续触发 10 次，弹窗展示次数必须等于 1）
 *   - 你选了「保持」之后，只要算出的周期没变就不再问
 *   - 只有你选了「改成 N 天」，CareRule 才会被写
 */

import type { CareRule, EntityId, PendingRuleConflict } from '../domain/types.js';

export type Resolution = 'keep-user' | 'take-computed';

export interface ComputedInterval {
  min: number;
  max: number;
}

export interface ConflictInput {
  plantId: EntityId;
  ruleId: EntityId;
  computed: ComputedInterval;
  user: ComputedInterval;
  reason: string;
  now: Date;
}

/** 两条冲突视为「同一个」的判据：同植物同规则，且算出的周期一致 */
function isSameConflict(existing: PendingRuleConflict, computed: ComputedInterval): boolean {
  return existing.computedMin === computed.min && existing.computedMax === computed.max;
}

/**
 * 决定要不要新建冲突。
 *
 * 返回 null 表示不需要打扰用户，原因有三种：
 *   - 没有规则可比（没设周期时谈不上冲突）
 *   - 算出来的和用户设的一样
 *   - 已经问过了：要么待处理中，要么用户刚拒绝过同一个值
 */
export function decideConflict(
  existing: PendingRuleConflict[],
  input: ConflictInput,
): { action: 'none'; reason: 'no-rule' | 'same' | 'already-pending' | 'user-declined' } | { action: 'create'; conflict: PendingRuleConflict } {
  const { plantId, ruleId, computed, user, reason, now } = input;

  if (computed.min === user.min && computed.max === user.max) {
    return { action: 'none', reason: 'same' };
  }

  const forThis = existing.filter((c) => c.plantId === plantId && c.ruleId === ruleId);

  // 还有没处理的：不要再建一条，也不要重复弹窗
  if (forThis.some((c) => !c.resolvedAt)) {
    return { action: 'none', reason: 'already-pending' };
  }

  // 用户已经拒绝过同一个算法结果：除非算出的值变了，否则不再问
  if (forThis.some((c) => c.resolvedAt && c.resolution === 'keep-user' && isSameConflict(c, computed))) {
    return { action: 'none', reason: 'user-declined' };
  }

  return {
    action: 'create',
    conflict: {
      id: `conflict-${plantId}-${computed.min}-${computed.max}`,
      plantId,
      ruleId,
      computedMin: computed.min,
      computedMax: computed.max,
      userMin: user.min,
      userMax: user.max,
      reason,
      createdAt: now.toISOString(),
      version: 0,
    },
  };
}

/**
 * 标记为「已问过」。
 *
 * W3 的关键：同一 conflictId 连续触发 10 次，弹窗展示次数必须等于 1。
 * 所以确认弹窗展示过一次后就要写 promptedAt，后续同一 id 不再弹。
 */
export function markPrompted(conflict: PendingRuleConflict, now: Date): PendingRuleConflict {
  if (conflict.promptedAt) return conflict;
  return { ...conflict, promptedAt: now.toISOString(), version: conflict.version + 1 };
}

/** 是否还应该弹窗 */
export function shouldPrompt(conflict: PendingRuleConflict): boolean {
  return !conflict.promptedAt && !conflict.resolvedAt;
}

export interface ResolutionResult {
  conflict: PendingRuleConflict;
  /** 只有 take-computed 时才有值。keep-user 时是 null，CareRule 一个字节都不动 */
  updatedRule: CareRule | null;
}

/**
 * 用户做出选择。
 *
 * keep-user    → 用户的 10 天是刻意的，系统建议被拒绝，不动 CareRule
 * take-computed → 用户同意改成系统算的值，这时才写 CareRule
 */
export function resolveConflict(
  conflict: PendingRuleConflict,
  mode: Resolution,
  rule: CareRule,
  now: Date,
): ResolutionResult {
  const resolved: PendingRuleConflict = {
    ...conflict,
    resolvedAt: now.toISOString(),
    resolution: mode,
    version: conflict.version + 1,
  };

  if (mode === 'keep-user') {
    return { conflict: resolved, updatedRule: null };
  }

  return {
    conflict: resolved,
    updatedRule: {
      ...rule,
      recommendedIntervalMin: conflict.computedMin,
      recommendedIntervalMax: conflict.computedMax,
      // 硬上下限跟着放宽，否则 recommended 比 maximum 还大，判定会自相矛盾
      minimumInterval: Math.max(1, Math.floor(conflict.computedMin * 0.7)),
      maximumInterval: Math.ceil(conflict.computedMax * 1.3),
      source: 'user',
      userOverride: true,
      updatedAt: now.toISOString(),
      version: rule.version + 1,
    },
  };
}

/** 给界面用的文案。数字要具体，用户靠它判断要不要改 */
export function describeConflict(c: PendingRuleConflict): {
  userText: string;
  computedText: string;
  headline: string;
} {
  return {
    userText: `${c.userMin} 到 ${c.userMax} 天`,
    computedText: `${c.computedMin} 到 ${c.computedMax} 天`,
    headline: `要调整这盆植物的浇水周期吗`,
  };
}
