/**
 * 领域类型定义。
 *
 * 本文件是整个系统的地基。后续的存储层、推荐引擎、界面层都从这里取类型。
 *
 * 三条不变量（在类型层面强制，违反则编译失败）：
 *   1. 建议的每一条 reason 都必须带 sourceId，否则无法追溯，界面不得显示。
 *   2. CareRule 是用户意图，系统只能写 pendingConflict，不能改 recommendedInterval。
 *   3. 所有事实类字段都带 source 标注，区分「测得的」「用户自述的」「推断的」。
 */

// ============================================================
// 基础
// ============================================================

export type ISODate = string; // YYYY-MM-DD
export type ISODateTime = string; // 本地时区 ISO，含偏移
export type EntityId = string;
export type Millis = number;

/** 事实来源标注。界面据此决定是否显示「这是推断」这类提示。 */
export type FactSource =
  | 'measured' // 传感器或外部 API 测得
  | 'user_stated' // 用户自己填的
  | 'user_provided_baseline' // 用户提供的经验基线（如 18cm 盆 = 500ml）
  | 'inferred' // 引擎从历史推断
  | 'unknown'; // 未知。宁可 unknown 也不编

// ============================================================
// 位置与暴露度（D-03）
// ============================================================

/**
 * 摆放位置。唯一枚举。
 * D-10：groupId 已取消，分组视图的列由此字段驱动，避免「位置」与「标签」打架。
 */
export const PLACEMENTS = ['客厅', '阳台', '卧室', '书房', '厨房', '卫生间', '玄关', '庭院', '办公室', '其他'] as const;
export type Placement = (typeof PLACEMENTS)[number];

/**
 * 暴露度。决定天气如何作用到这株植物。
 *
 * D-03 的核心：同一个 29°C，套给窗边龟背竹和露天薄荷是错的。
 * 降雨只对 outdoor / semi_outdoor 生效；室内不受降雨影响。
 */
export type Exposure = 'indoor' | 'indoor_window' | 'semi_outdoor' | 'outdoor';

export interface ExposureProfile {
  exposure: Exposure;
  /** 1.0 = 露天，0 = 完全不受降雨影响 */
  rainFactor: number;
  /** 1.0 = 全日照，0.3 = 长期无直射光 */
  lightFactor: number;
  /** 温度变化对蒸腾的放大系数，室外波动更大 */
  tempVarianceFactor: number;
}

/** D-02：光照是静态枚举字段，会随季节和位置变化而过期，这是已接受的取舍。 */
/** 暴露度的人类可读说明。枚举值是英文，界面上不得直接显示。 */
export const EXPOSURE_LABEL: Record<Exposure, string> = {
  indoor: '室内',
  indoor_window: '室内靠窗',
  semi_outdoor: '半户外',
  outdoor: '露天',
};

/** 暴露度的详细说明，界面上用于解释天气为何这样影响这株植物 */
export const EXPOSURE_DESC: Record<Exposure, string> = {
  indoor: '不直接受降雨影响',
  indoor_window: '靠窗，可能接到少量飘雨',
  semi_outdoor: '下雨会被淋到',
  outdoor: '完全暴露在户外',
};

export const LIGHT_PROFILES = ['直射强', '直射中', '散射', '补光'] as const;
export type LightProfile = (typeof LIGHT_PROFILES)[number];

// ============================================================
// Plant
// ============================================================

export interface Plant {
  id: EntityId;
  /** 用户自己起的名字。每盆独立，同品种多盆完全分离。 */
  name: string;
  species?: string;
  family?: string;
  genus?: string;
  coverImageId?: EntityId;

  purchaseDate?: ISODate;
  /** 来源 / 店铺 */
  source?: string;
  /** 城市，默认广州（D-15） */
  city?: string;
  placement: Placement;
  /** 花盆口径，cm。用于浇水估算（D-13） */
  potDiameterCm?: number;
  lightProfile?: LightProfile;
  exposure: Exposure;

  tags: string[];
  notes?: string;

  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  /** 乐观锁（D-17）。写入前校验，不一致则拒绝静默覆盖。 */
  version: number;
}

// ============================================================
// CareRule
// ============================================================

/**
 * 周期来源。
 * D-11：第一版不做品种库，source 不会有 'database'，但枚举保留以便将来接入。
 */
export type CareRuleSource = 'user' | 'database' | 'inferred';

export interface CareRule {
  id: EntityId;
  plantId: EntityId;

  /** 用户设定的推荐周期，天 */
  recommendedIntervalMin: number;
  recommendedIntervalMax: number;
  /** 硬下限，低于此值不得建议浇水 */
  minimumInterval: number;
  /** 硬上限，超过此值应建议浇水 */
  maximumInterval: number;

  source: CareRuleSource;
  /**
   * 用户是否手动设过。一旦为 true，系统永不自动改写本对象。
   * D-13 / W3：这是「用户覆盖优先」这条铁律的落地点。
   */
  userOverride: boolean;
  updatedAt: ISODateTime;
  version: number;
}

/**
 * 规则冲突。系统算出周期与用户设定不一致时，只写这里，绝不写 CareRule。
 *
 * W3 断言：同一 conflictId 连续触发 10 次，弹窗实际展示次数必须等于 1。
 */
export interface PendingRuleConflict {
  id: EntityId;
  plantId: EntityId;
  ruleId: EntityId;
  /** 系统算出的周期 */
  computedMin: number;
  computedMax: number;
  /** 用户当前设定 */
  userMin: number;
  userMax: number;
  /** 触发原因，可直接展示给用户 */
  reason: string;
  createdAt: ISODateTime;
  /** 是否已向用户展示过弹窗。用于保证「只弹一次」 */
  promptedAt?: ISODateTime;
  resolvedAt?: ISODateTime;
  /** keep | take-computed */
  resolution?: 'keep-user' | 'take-computed';
}

// ============================================================
// WateringRecord
// ============================================================

export const WATERING_METHODS = ['浇透', '喷雾', '浸盆', '其它'] as const;
export type WateringMethod = (typeof WATERING_METHODS)[number];

export interface WateringRecord {
  id: EntityId;
  plantId: EntityId;

  /** 本地时区日期与时间 */
  date: ISODate;
  time: string; // HH:mm

  /**
   * 水量，ml。可能是估算值。
   * D-13：估算必须带 amountSource，界面据此标注「按 18cm 盆 500ml 估算」。
   */
  amountMl?: number;
  amountSource?: FactSource;

  method: WateringMethod;
  fertilizerIncluded: boolean;
  notes?: string;
  images: EntityId[];

  /**
   * 补录队列状态（D-06 X 方案）。
   *
   * complete = 已补全，正常参与统计与判定
   * pending  = 待补全，快速批量记录的副产品。不参与判定与统计
   * expired  = 历史空白。超过 pendingCompletionDays 仍未补全，
   *            自动降级为「水量未知」，不再提示用户补。
   *            这是队列长度的收敛机制，必须存在，否则队列无限堆积。
   */
  completionState: 'complete' | 'pending' | 'expired';
  entrySource: 'bulk' | 'single';

  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  version: number;
}

// ============================================================
// PlantEvent
// ============================================================

/**
 * 事件类型。D-08 已删除 GrowthRecord，全部事件统一走 PlantEvent。
 * 成长时间线 = type IN (下面标 growthTimeline 的那批) 的时间序视图。
 */
export const PLANT_EVENT_TYPES = [
  'WATERING',
  'FERTILIZING',
  'REPOTTING',
  'PRUNING',
  'FLOWERING',
  'FRUITING',
  'NEW_LEAF',
  'YELLOW_LEAF',
  'SHED_LEAF',
  'PEST',
  'DISEASE',
  'STATUS_CHANGE',
  'PHOTO',
  'NOTE',
  'CUSTOM',
] as const;
export type PlantEventType = (typeof PLANT_EVENT_TYPES)[number];

/** 成长时间线包含的类型。D-08：视图而非表。 */
export const GROWTH_TIMELINE_TYPES: readonly PlantEventType[] = [
  'PHOTO',
  'NEW_LEAF',
  'YELLOW_LEAF',
  'FLOWERING',
  'FRUITING',
  'REPOTTING',
  'PRUNING',
  'PEST',
  'DISEASE',
];

/**
 * 每种 type 的必填字段校验（D-08 硬要求）。
 * 防止 metadata 退化成无约束的 JSON 袋。
 */
export const EVENT_REQUIRED_FIELDS: Partial<Record<PlantEventType, readonly (keyof PlantEvent)[]>> = {
  PHOTO: ['title', 'images'],
  NEW_LEAF: ['title'],
  YELLOW_LEAF: ['title'],
  PEST: ['title', 'description'],
  DISEASE: ['title', 'description'],
};

export interface PlantEvent {
  id: EntityId;
  plantId: EntityId;
  type: PlantEventType;
  date: ISODate;
  /** 原 GrowthRecord.caption，D-08 起降级为此字段 */
  title?: string;
  /** 原 GrowthRecord.notes */
  description?: string;
  images: EntityId[];
  /** type-specific 字段，必须符合 EVENT_REQUIRED_FIELDS */
  metadata: Record<string, unknown>;

  createdAt: ISODateTime;
  version: number;
}

// ============================================================
// 天气
// ============================================================

export interface WeatherSnapshot {
  id: EntityId;
  city: string;
  latitude: number;
  longitude: number;
  /** 快照时间，非预报时间 */
  timestamp: ISODateTime;

  temperature: number;
  humidity: number;
  rainProbability: number;
  rainfall: number;
  windSpeed: number;
  /** 日照小时数 */
  sunlight: number;
  weatherCondition: string;

  /** 未来 48 小时逐小时预报 */
  forecast: ForecastHour[];

  /** 数据来源，可写接口名以便回显 */
  provider: string;
}

export interface ForecastHour {
  timestamp: ISODateTime;
  temperature: number;
  humidity: number;
  rainProbability: number;
  precipitation: number;
}

/** 天气不可用时，引擎用它显式降级，而不是假装有数据。 */
export interface WeatherUnavailable {
  unavailable: true;
  /** 最后一次成功获取的时间，界面必须展示 */
  lastSuccessAt?: ISODateTime;
  reason: string;
}

export type WeatherInput =
  | { available: true; snapshot: WeatherSnapshot }
  | { available: false; fallback: WeatherUnavailable };

// ============================================================
// 推荐
// ============================================================

export const ACTIONS = ['CHECK', 'WATER_NOW', 'DELAY', 'NO_ACTION'] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * 建议的一条依据。
 *
 * 不变量 1：sourceId 必填。没有它无法追溯到具体数据，界面不得显示这条依据。
 * 这是编译期约束，不是运行时检查。
 */
export interface Reason {
  text: string;
  /** 必须能定位到具体实体：watering record id / weather snapshot id / care rule id */
  sourceId: EntityId;
  sourceKind: 'watering_record' | 'weather' | 'care_rule' | 'derived' | 'inferred_pattern' | 'exposure';
  source: FactSource;
}

export interface Recommendation {
  id: EntityId;
  plantId: EntityId;
  generatedAt: ISODateTime;

  action: Action;
  /** 0..1，由命中的规则数量与可信度加权计算，不是模型自评 */
  confidence: number;
  reasons: Reason[];
  /** 一句话建议 */
  suggestedAction: string;
  /** DELAY 时的建议延后天数 */
  suggestedDelayDays?: number;

  /** 引擎读了什么，可回放 */
  basedOn: {
    careRuleId?: EntityId;
    lastWateringId?: EntityId;
    wateringCount: number;
    weatherSnapshotId?: EntityId;
    /** 天气不可用时为 true，界面必须提示 */
    weatherUnavailable: boolean;
  };

  userConfirmed: boolean;
  version: number;
}

// ============================================================
// 决定日志（闭环末端）
// ============================================================

export const USER_ACTIONS = ['confirm', 'watered', 'delay', 'skip', 'dismiss', 'judged_no_need'] as const;
export type UserAction = (typeof USER_ACTIONS)[number];

export interface DecisionLog {
  id: EntityId;
  plantId: EntityId;
  recommendationId: EntityId;
  action: UserAction;
  /** 系统建议的延后天数 */
  suggestedDelayDays?: number;
  userConfirmedAt: ISODateTime;
  /** judged_no_need 用于 P 页「你判断对了 / 与规则不一致」的回顾 */
  note?: string;
}

// ============================================================
// 设置
// ============================================================

export interface Settings {
  city: string;
  /** D-15：来源 Open-Meteo Geocoding API，2026-09-30 实际返回，非推测 */
  latitude: number;
  longitude: number;
  timezone: string;
  /** D-14：默认 30 分钟 */
  weatherRefreshMinutes: number;
  /** D-06：超过 14 天未补全移入历史空白 */
  pendingCompletionDays: number;
  /** D-13：18cm 盆 = 500ml，用户提供的经验基线 */
  baselinePotDiameterCm: number;
  baselineWaterMl: number;
  updatedAt: ISODateTime;
}
