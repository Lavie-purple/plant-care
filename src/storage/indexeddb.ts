/**
 * IndexedDB 存储层。
 *
 * D-17：多窗口场景下必须正确同步。策略是
 *   1. 写入后通过 BroadcastChannel 广播变更（只广播类型和 id，不传数据）
 *   2. 接收方收到广播后从 IndexedDB 重读（图片 Blob 无法经广播序列化）
 *   3. 写入时校验 updatedAt，冲突则拒绝静默覆盖
 *
 * 为什么不用 fake-indexeddb 之外的东西：浏览器原生 IndexedDB 在 Node 里不存在，
 * 测试需要一个内存实现。真实浏览器行为与 fake-indexeddb 高度一致，但
 * 「乐观锁」逻辑是我们自己的，必须在内存实现上真跑一遍才算数。
 */

import type {
  CareRule,
  DecisionLog,
  EntityId,
  Plant,
  PlantEvent,
  PendingRuleConflict,
  Recommendation,
  Settings,
  WateringRecord,
  WeatherSnapshot,
} from '../domain/types.js';

// ============================================================
// 表定义
// ============================================================

export const STORES = {
  plants: 'plants',
  careRules: 'careRules',
  wateringRecords: 'wateringRecords',
  plantEvents: 'plantEvents',
  weatherSnapshots: 'weatherSnapshots',
  recommendations: 'recommendations',
  pendingConflicts: 'pendingConflicts',
  decisionLogs: 'decisionLogs',
  settings: 'settings',
  images: 'images',
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

/** 各表的主键与索引 */
export const SCHEMA: Record<StoreName, { keyPath: string; indexes: { name: string; keyPath: string | string[]; unique?: boolean }[] }> = {
  plants: { keyPath: 'id', indexes: [{ name: 'by_placement', keyPath: 'placement' }, { name: 'by_updatedAt', keyPath: 'updatedAt' }] },
  careRules: { keyPath: 'id', indexes: [{ name: 'by_plant', keyPath: 'plantId', unique: true }] },
  wateringRecords: {
    keyPath: 'id',
    indexes: [
      { name: 'by_plant_date', keyPath: ['plantId', 'date'] },
      { name: 'by_plant', keyPath: 'plantId' },
      { name: 'by_completion', keyPath: 'completionState' },
    ],
  },
  plantEvents: {
    keyPath: 'id',
    indexes: [
      { name: 'by_plant_date', keyPath: ['plantId', 'date'] },
      { name: 'by_plant_type', keyPath: ['plantId', 'type'] },
      { name: 'by_plant', keyPath: 'plantId' },
    ],
  },
  // 天气快照只保留最近 N 条，按时间倒序裁剪，避免无限增长
  weatherSnapshots: { keyPath: 'id', indexes: [{ name: 'by_timestamp', keyPath: 'timestamp' }] },
  recommendations: { keyPath: 'id', indexes: [{ name: 'by_plant', keyPath: 'plantId' }, { name: 'by_generatedAt', keyPath: 'generatedAt' }] },
  pendingConflicts: { keyPath: 'id', indexes: [{ name: 'by_plant', keyPath: 'plantId' }, { name: 'by_createdAt', keyPath: 'createdAt' }] },
  decisionLogs: { keyPath: 'id', indexes: [{ name: 'by_plant', keyPath: 'plantId' }, { name: 'by_recommendation', keyPath: 'recommendationId' }] },
  settings: { keyPath: 'city', indexes: [] },
  images: { keyPath: 'id', indexes: [{ name: 'by_createdAt', keyPath: 'createdAt' }] },
};

/** 天气快照保留条数。超出后删除最旧的，避免存储无限增长。 */
export const WEATHER_SNAPSHOT_RETENTION = 200;

export const DB_NAME = 'plant-manager';
/**
 * schema 版本。加字段或改索引时必须 +1，否则老库不会重建索引。
 * 记录变更历史：1 = 初始 schema。
 */
export const DB_VERSION = 2;

/**
 * 库名可覆盖。测试需要每个用例独立的库，否则 fake-indexeddb 下
 * 并发 open/close 会让 onupgradeneeded 只触发一次，后续用例拿不到表。
 */
let dbNameOverride: string | undefined;
export function setDatabaseName(name: string | undefined): void {
  dbNameOverride = name;
}
export function getDatabaseName(): string {
  return dbNameOverride ?? DB_NAME;
}

// ============================================================
// 冲突（D-17）
// ============================================================

/** 写入时发现版本不一致，调用方必须让用户选择，不得静默覆盖 */
export class OptimisticLockError extends Error {
  readonly store: StoreName;
  readonly id: EntityId;
  /** 我读到的版本 */
  readonly expectedVersion: number;
  /** 库里现在的版本 */
  readonly actualVersion: number;

  constructor(store: StoreName, id: EntityId, expected: number, actual: number) {
    super(`并发修改冲突：${store}/${id} 期望版本 ${expected}，实际已是 ${actual}。请刷新后重试。`);
    this.name = 'OptimisticLockError';
    this.store = store;
    this.id = id;
    this.expectedVersion = expected;
    this.actualVersion = actual;
  }
}

// ============================================================
// 广播消息
// ============================================================

export type ChangeMessage =
  | { kind: 'put'; store: StoreName; id: EntityId }
  | { kind: 'delete'; store: StoreName; id: EntityId }
  | { kind: 'clear' }
  | { kind: 'hello' } // 新窗口加入，请求其他窗口全量刷新
  | { kind: 'ping' }; // 心跳，用于探测对端存在

export const BROADCAST_CHANNEL = 'plant-manager-changes';
