/**
 * 导出与导入的数据契约（D-18）。
 *
 * 这是 local-first 的最后一根保险。设计上有三条硬约束：
 *
 *   1. **导入必须先校验再落库**。任何一条记录不合法就整体拒绝，
 *      绝不允许「导进去一半」。半个数据集比没有数据集更危险。
 *   2. **版本不匹配必须显式报错**，不做「尽力而为」的猜测迁移。
 *      schemaVersion 不认识时拒绝导入，让用户知道该升级应用。
 *   3. **导出必须包含图片**。只导出 URL 和元数据等于假装备份过。
 *
 * 本文件是纯函数，不碰文件系统也不碰 IndexedDB，便于完整测试。
 * 文件读写在 exportFiles.ts。
 */

import type {
  CareRule,
  DecisionLog,
  EntityId,
  Plant,
  PlantEvent,
  PendingRuleConflict,
  Recommendation,
  ImageManifestEntry,
  Settings,
  WateringRecord,
  WeatherSnapshot,
} from '../domain/types.js';

/**
 * 数据格式版本。改字段结构时必须 +1，并在 MIGRATIONS 里加迁移函数。
 * 记录变更历史：
 *   1 = 初始（PlantEvent 合并 GrowthRecord 之后，见 D-08）
 */
export const SCHEMA_VERSION = 1;

export interface ExportBundle {
  schemaVersion: number;
  exportedAt: string;
  app: { name: string; version: string };
  counts: Record<string, number>;
  data: {
    plants: Plant[];
    careRules: CareRule[];
    wateringRecords: WateringRecord[];
    plantEvents: PlantEvent[];
    weatherSnapshots: WeatherSnapshot[];
    recommendations: Recommendation[];
    pendingConflicts: PendingRuleConflict[];
    decisionLogs: DecisionLog[];
    settings: Settings[];
  };
  /**
   * 图片清单。**不含二进制**——data.json 保持可读可 diff，
   * 图片本体写到同目录的 images/ 下。
   * D-18：只导出引用和元数据等于假装备份过。
   */
  images: ImageManifestEntry[];
}

export const APP_INFO = { name: 'personal-plant-manager', version: '0.1.0' };

export interface ExportInput {
  plants: Plant[];
  careRules: CareRule[];
  wateringRecords: WateringRecord[];
  plantEvents: PlantEvent[];
  weatherSnapshots: WeatherSnapshot[];
  recommendations: Recommendation[];
  pendingConflicts: PendingRuleConflict[];
  decisionLogs: DecisionLog[];
  settings: Settings[];
  images: ImageManifestEntry[];
  /** 由调用方注入，导出函数不读时钟 */
  now: Date;
}

// ============================================================
// 导出
// ============================================================

export function buildBundle(input: ExportInput): ExportBundle {
  const data: ExportBundle['data'] = {
    plants: input.plants,
    careRules: input.careRules,
    wateringRecords: input.wateringRecords,
    plantEvents: input.plantEvents,
    weatherSnapshots: input.weatherSnapshots,
    recommendations: input.recommendations,
    pendingConflicts: input.pendingConflicts,
    decisionLogs: input.decisionLogs,
    settings: input.settings,
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: input.now.toISOString(),
    app: APP_INFO,
    counts: {
      plants: data.plants.length,
      careRules: data.careRules.length,
      wateringRecords: data.wateringRecords.length,
      plantEvents: data.plantEvents.length,
      weatherSnapshots: data.weatherSnapshots.length,
      recommendations: data.recommendations.length,
      pendingConflicts: data.pendingConflicts.length,
      decisionLogs: data.decisionLogs.length,
      settings: data.settings.length,
      images: input.images.length,
    },
    data,
    images: input.images,
  };
}

// ============================================================
// 导入校验
// ============================================================

export type ImportProblem =
  | { kind: 'not_json'; detail: string }
  | { kind: 'bad_schema_version'; found: unknown; expected: number }
  | { kind: 'missing_field'; store: string; index: number; field: string }
  | { kind: 'duplicate_id'; store: string; id: EntityId }
  | { kind: 'dangling_reference'; store: string; index: number; field: string; ref: EntityId };

export interface ImportValidation {
  ok: boolean;
  bundle?: ExportBundle;
  problems: ImportProblem[];
  /** 便于界面显示「将导入 N 盆植物、M 条浇水记录」 */
  summary: Record<string, number>;
}

const STORE_KEYS: (keyof ExportBundle['data'])[] = [
  'plants',
  'careRules',
  'wateringRecords',
  'plantEvents',
  'weatherSnapshots',
  'recommendations',
  'pendingConflicts',
  'decisionLogs',
  'settings',
];

const IMAGE_KEY = 'images';

/** 每类记录必须有的最小字段。缺任何一条都拒绝导入。 */
const REQUIRED_FIELDS: Record<keyof ExportBundle['data'], string[]> = {
  plants: ['id', 'name', 'placement', 'exposure', 'createdAt', 'updatedAt', 'version'],
  careRules: ['id', 'plantId', 'recommendedIntervalMin', 'recommendedIntervalMax', 'userOverride'],
  wateringRecords: ['id', 'plantId', 'date', 'time', 'method', 'completionState', 'entrySource'],
  plantEvents: ['id', 'plantId', 'type', 'date'],
  weatherSnapshots: ['id', 'city', 'timestamp', 'temperature', 'humidity'],
  recommendations: ['id', 'plantId', 'generatedAt', 'action', 'reasons'],
  pendingConflicts: ['id', 'plantId', 'computedMin', 'computedMax'],
  decisionLogs: ['id', 'plantId', 'recommendationId', 'action', 'userConfirmedAt'],
  settings: ['city', 'latitude', 'longitude', 'timezone'],
};

/** 会引用 plantId 的表，用于检查悬挂引用 */
const REFERENCES_PLANT: (keyof ExportBundle['data'])[] = [
  'careRules',
  'wateringRecords',
  'plantEvents',
  'recommendations',
  'pendingConflicts',
  'decisionLogs',
];

/**
 * 校验导入数据。**任何一条问题都导致整体拒绝**（ok = false）。
 * 部分导入会产生半截数据集，那比不导入更糟。
 */
export function validateBundle(raw: unknown): ImportValidation {
  const problems: ImportProblem[] = [];

  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, problems: [{ kind: 'not_json', detail: '顶层不是对象' }], summary: {} };
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.schemaVersion !== 'number') {
    return {
      ok: false,
      problems: [{ kind: 'bad_schema_version', found: obj.schemaVersion, expected: SCHEMA_VERSION }],
      summary: {},
    };
  }
  if (obj.schemaVersion !== SCHEMA_VERSION) {
    return {
      ok: false,
      problems: [{ kind: 'bad_schema_version', found: obj.schemaVersion, expected: SCHEMA_VERSION }],
      summary: {},
    };
  }

  const data = obj.data as Record<string, unknown> | undefined;
  if (typeof data !== 'object' || data === null) {
    return { ok: false, problems: [{ kind: 'not_json', detail: '缺少 data 字段' }], summary: {} };
  }

  const summary: Record<string, number> = {};
  const imageList = data[IMAGE_KEY];
  if (imageList !== undefined && !Array.isArray(imageList)) {
    problems.push({ kind: 'not_json', detail: 'images 不是数组' });
  }
  const plantIds = new Set<string>();
  const seenIds = new Set<string>();

  for (const key of STORE_KEYS) {
    const list = data[key];
    if (!Array.isArray(list)) {
      problems.push({ kind: 'not_json', detail: `${key} 不是数组` });
      continue;
    }
    summary[key] = list.length;

    const required = REQUIRED_FIELDS[key];
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i] as Record<string, unknown> | null;
      if (typeof item !== 'object' || item === null) {
        problems.push({ kind: 'missing_field', store: key, index: i, field: '(整条不是对象)' });
        continue;
      }
      for (const f of required) {
        if (item[f] === undefined || item[f] === null) {
          problems.push({ kind: 'missing_field', store: key, index: i, field: f });
        }
      }
      const id = item.id;
      if (typeof id === 'string') {
        const dedupeKey = `${key}:${id}`;
        if (seenIds.has(dedupeKey)) {
          problems.push({ kind: 'duplicate_id', store: key, id });
        }
        seenIds.add(dedupeKey);
        if (key === 'plants') plantIds.add(id);
      }
    }
  }

  // 悬挂引用：引用了不存在的植物。这类数据导入后会静默出错，必须挡住
  for (const key of REFERENCES_PLANT) {
    const list = data[key];
    if (!Array.isArray(list)) continue;
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i] as Record<string, unknown> | null;
      const ref = item?.plantId;
      if (typeof ref === 'string' && !plantIds.has(ref)) {
        problems.push({ kind: 'dangling_reference', store: key, index: i, field: 'plantId', ref });
      }
    }
  }

  return {
    ok: problems.length === 0,
    ...(problems.length === 0 ? { bundle: raw as ExportBundle } : {}),
    problems,
    summary,
  };
}

// ============================================================
// 合并策略
// ============================================================

export type ImportMode = 'merge' | 'replace';

export interface MergeResult {
  bundle: ExportBundle;
  /** 合并时被跳过的记录，界面要告诉用户「已有 N 条同名记录未导入」 */
  skipped: { store: string; id: EntityId }[];
  added: Record<string, number>;
}

/**
 * 合并策略。
 *
 * merge   —— 同 id 已存在则跳过，不覆盖用户现有数据
 * replace —— 先清空再写入，用于「我要完全恢复到某个备份」
 */
export function applyImport(
  incoming: ExportBundle,
  existing: ExportBundle['data'],
  mode: ImportMode,
): MergeResult {
  if (mode === 'replace') {
    const added: Record<string, number> = {};
    for (const key of STORE_KEYS) {
      added[key] = incoming.data[key].length;
    }
    return { bundle: { ...incoming, data: incoming.data }, skipped: [], added };
  }

  const skipped: { store: string; id: EntityId }[] = [];
  const added: Record<string, number> = {};
  const out = {} as ExportBundle['data'];

  for (const key of STORE_KEYS) {
    const have = new Set((existing[key] as { id?: EntityId; city?: string }[]).map((x) => x.id ?? x.city));
    const merged: unknown[] = [];
    for (const item of incoming.data[key]) {
      const id = (item as { id?: EntityId; city?: string }).id ?? (item as { city?: string }).city;
      if (id !== undefined && have.has(id)) {
        skipped.push({ store: key, id });
        continue;
      }
      merged.push(item);
    }
    (out as Record<string, unknown>)[key] = [...(existing[key] as unknown[]), ...merged];
    added[key] = merged.length;
  }

  return { bundle: { ...incoming, data: out }, skipped, added };
}

/** 把校验问题转成人话，供界面直接显示 */
export function describeProblem(p: ImportProblem): string {
  switch (p.kind) {
    case 'not_json':
      return `文件结构不对：${p.detail}`;
    case 'bad_schema_version':
      return `数据版本是 ${String(p.found)}，本应用只认 ${p.expected}。请用相同版本的应用导出后再导入。`;
    case 'missing_field':
      return `${p.store} 第 ${p.index + 1} 条缺少字段「${p.field}」`;
    case 'duplicate_id':
      return `${p.store} 里 id ${p.id} 重复`;
    case 'dangling_reference':
      return `${p.store} 第 ${p.index + 1} 条引用了不存在的植物 ${p.ref}`;
  }
}
