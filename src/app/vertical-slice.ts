/**
 * 最小垂直闭环。
 *
 * 这是整个产品的第一条主线，也是 AGENTS.md 要求的第一个可验证目标：
 *
 *   建植物 → 设养护规则 → 记一次浇水 → 取天气 → 出建议 → 确认 → 落记录 → 影响下一次判断
 *
 * 全部通过 MockWeatherProvider 运行，不依赖网络，因此这条测试在任何网络状态下
 * 都能重复跑出同样结果。
 */

import type {
  CareRule,
  DecisionLog,
  PlantEvent,
  Plant,
  Settings,
  UserAction,
  WateringMethod,
  WateringRecord,
} from '../domain/types.js';
import { generateRecommendation, type EngineOutput } from '../engine/recommendation.js';
import { Repository } from '../storage/repository.js';
import { buildQueue, completeRecord, DEFAULT_PENDING_DAYS, type QueueItem } from './completionQueue.js';
import { DataTransferService } from '../data/DataTransferService.js';
import { STORES } from '../storage/indexeddb.js';
import { toWeatherInput, type WeatherProvider } from '../weather/provider.js';
import type { WeatherInput } from '../domain/types.js';

export const DEFAULT_SETTINGS: Settings = {
  city: '广州',
  // D-15：来源 Open-Meteo Geocoding API，2026-09-30 实际返回，非推测
  latitude: 23.11667,
  longitude: 113.25,
  timezone: 'Asia/Shanghai',
  weatherRefreshMinutes: 30,
  pendingCompletionDays: 14,
  // D-13：用户提供的经验基线，非品种数据
  baselinePotDiameterCm: 18,
  baselineWaterMl: 500,
  updatedAt: '2026-09-30T00:00:00+08:00',
};

/**
 * 浇水量估算（D-13）。
 *
 * 换算规则：ml = 500 × (口径cm / 18)³
 * 这是按盆容积立方比例外推，假设花盆深度与口径成正比。
 * 该假设是近似，代码注释中已标明；界面必须显示「按 18cm 盆 500ml 估算」。
 */
export function estimateWateringMl(potDiameterCm: number | undefined, settings: Settings = DEFAULT_SETTINGS): number | undefined {
  if (potDiameterCm === undefined || potDiameterCm <= 0) return undefined;
  const ratio = potDiameterCm / settings.baselinePotDiameterCm;
  return Math.round(settings.baselineWaterMl * ratio ** 3);
}

let idSeq = 0;
function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

/** 时钟由外部注入，便于测试固定时间 */
export interface Clock {
  now(): Date;
  localDate(): string;
  localTime(): string;
}

export function systemClock(): Clock {
  return {
    now: () => new Date(),
    localDate: () => {
      const d = new Date();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${d.getFullYear()}-${m}-${day}`;
    },
    localTime: () => {
      const d = new Date();
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    },
  };
}

export function fixedClock(iso: string): Clock {
  const d = new Date(iso);
  return {
    now: () => d,
    localDate: () => {
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${d.getFullYear()}-${m}-${day}`;
    },
    localTime: () => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
  };
}

// ============================================================
// 用例层：上面每个动作对应一个方法，界面层直接调用
// ============================================================

export class PlantCareService {
  constructor(
    private readonly repo: Repository,
    private readonly weather: WeatherProvider,
    private readonly clock: Clock = systemClock(),
  ) {}

  /** 1. 建一盆植物 */
  async addPlant(input: {
    name: string;
    placement: Plant['placement'];
    exposure: Plant['exposure'];
    potDiameterCm?: number;
    species?: string;
    family?: string;
    tags?: string[];
  }): Promise<Plant> {
    const now = this.clock.now().toISOString();
    return this.repo.put<Plant>(STORES.plants, {
      id: nextId('plant'),
      name: input.name,
      ...(input.species !== undefined ? { species: input.species } : {}),
      ...(input.family !== undefined ? { family: input.family } : {}),
      city: DEFAULT_SETTINGS.city,
      placement: input.placement,
      exposure: input.exposure,
      ...(input.potDiameterCm !== undefined ? { potDiameterCm: input.potDiameterCm } : {}),
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
      version: 0,
    });
  }

  /** 2. 设置养护规则。userOverride 置 true，此后系统永不自动改写。 */
  async setCareRule(plantId: string, min: number, max: number): Promise<CareRule> {
    return this.repo.put<CareRule>(STORES.careRules, {
      id: nextId('rule'),
      plantId,
      recommendedIntervalMin: min,
      recommendedIntervalMax: max,
      minimumInterval: Math.max(1, Math.floor(min * 0.7)),
      maximumInterval: Math.ceil(max * 1.3),
      source: 'user',
      userOverride: true,
      updatedAt: this.clock.now().toISOString(),
      version: 0,
    });
  }

  /**
   * 3. 记一次浇水。
   * 只给时间也能记（D-06 的 V 方案），水量可事后补。
   */
  async recordWatering(
    plantId: string,
    opts: {
      method?: WateringMethod;
      amountMl?: number;
      entrySource?: 'bulk' | 'single';
      date?: string;
      time?: string;
    } = {},
  ): Promise<WateringRecord> {
    const plant = await this.repo.getPlant(plantId);
    if (!plant) throw new Error(`植物不存在：${plantId}`);

    // 未填水量时按 D-13 估算，并标记来源
    const estimated = opts.amountMl ?? estimateWateringMl(plant.potDiameterCm);
    const amountSource = opts.amountMl !== undefined ? 'user_stated' : 'user_provided_baseline';

    return this.repo.put<WateringRecord>(STORES.wateringRecords, {
      id: nextId('water'),
      plantId,
      date: opts.date ?? this.clock.localDate(),
      time: opts.time ?? this.clock.localTime(),
      ...(estimated !== undefined ? { amountMl: estimated, amountSource } : {}),
      method: opts.method ?? '浇透',
      fertilizerIncluded: false,
      images: [],
      // 入口约束：单株入口直接补全，批量入口才进补录队列
      completionState: opts.entrySource === 'bulk' ? 'pending' : 'complete',
      entrySource: opts.entrySource ?? 'single',
      createdAt: this.clock.now().toISOString(),
      updatedAt: this.clock.now().toISOString(),
      version: 0,
    });
  }

  /**
   * 4. 取天气。失败时降级，不抛给界面。
   *
   * D-14 的关键约束：断网时**不得**拿缓存当新数据返回。
   * 早期版本在 fetch 失败后回落到 latestWeatherSnapshot()，
   * 结果用户会拿到几分钟前的数据却以为拿到了新的，违反「不得假装是实时」。
   * 现在：fetch 失败一律返回 unavailable，缓存由界面层显式调用 readCache 展示，
   * 且必须带 lastSuccessAt 时间戳让用户知道数据有多旧。
   */
  async loadWeather(): Promise<WeatherInput> {
    try {
      const snap = await this.weather.fetch(DEFAULT_SETTINGS);
      await this.repo.saveWeatherSnapshot(snap);
      return { available: true, snapshot: snap };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      // 只取时间戳用于告知用户「数据有多旧」，不把缓存内容当作本次结果
      const cached = await this.repo.latestWeatherSnapshot();
      return toWeatherInput(undefined, {
        reason,
        ...(cached ? { lastSuccessAt: cached.timestamp } : {}),
      });
    }
  }

  /** 界面层用这个显式取缓存，并在 UI 上标注「这是 X 分钟前的数据」 */
  async readCachedWeather(): Promise<WeatherInput> {
    const cached = await this.repo.latestWeatherSnapshot();
    if (!cached) return toWeatherInput(undefined, { reason: '尚未获取过天气数据' });
    return { available: true, snapshot: cached };
  }

  /** 单株浇水历史，界面翻译来源说明时需要 */
  async wateringHistory(plantId: string): Promise<WateringRecord[]> {
    return this.repo.wateringHistory(plantId);
  }

  /**
   * 待补全队列（D-06 X 方案）。
   * 每次读取前先扫一次过期，避免队列无限堆积。
   */
  async completionQueue(): Promise<QueueItem[]> {
    const plants = await this.listPlants();
    const records = await this.repo.allPendingRecords();
    return buildQueue({ plants, records, today: this.clock.now() });
  }

  /** 完成一条补录 */
  async completeWatering(
    recordId: string,
    patch: { amountMl?: number; method?: WateringMethod; fertilizerIncluded?: boolean; notes?: string },
  ): Promise<void> {
    const r = await this.repo.get<WateringRecord>(STORES.wateringRecords, recordId);
    if (!r) throw new Error();
    const next = completeRecord({ record: r, ...patch, now: this.clock.now() });
    await this.repo.forcePut<WateringRecord>(STORES.wateringRecords, next);
  }

  /** 把超期的待补全记录降级为「历史空白」。启动时调一次。 */
  async sweepStalePending(): Promise<number> {
    return this.repo.expireStalePending(DEFAULT_PENDING_DAYS, this.clock.now());
  }

  /** 数据搬运服务（导出/导入）。仓库实例由这里持有，界面层不接触。 */
  dataTransfer(): DataTransferService {
    return new DataTransferService(this.repo, { now: () => this.clock.now() });
  }

  /** 单株植物，可能已删除 */
  async getPlant(plantId: string): Promise<Plant | undefined> {
    return this.repo.getPlant(plantId);
  }

  /** 当前时刻。统计区间需要它，界面层不应访问私有 clock */
  now(): Date {
    return this.clock.now();
  }

  /** 单株全部事件，详情页「记录」tab 用 */
  async events(plantId: string): Promise<PlantEvent[]> {
    return this.repo.plantEvents(plantId);
  }

  /** 成长时间线（D-08：PlantEvent 的一个视图，不是独立表） */
  async timeline(plantId: string): Promise<PlantEvent[]> {
    return this.repo.growthTimeline(plantId);
  }

  /** 决定日志，「统计」tab 的行为数据来源 */
  async decisions(plantId: string): Promise<DecisionLog[]> {
    return this.repo.decisionsFor(plantId);
  }

  /** 养护规则，可能未设置 */
  async careRule(plantId: string): Promise<CareRule | undefined> {
    return this.repo.getCareRuleByPlant(plantId);
  }

  /** 列出全部植物 */
  async listPlants(): Promise<Plant[]> {
    return this.repo.allPlants();
  }

  /** 未解决的规则冲突条数，Today 页面顶部提醒条用 */
  async countUnresolvedConflicts(): Promise<number> {
    return (await this.repo.unresolvedConflicts()).length;
  }

  /** 5. 生成建议。 */
  async recommend(plantId: string, weather: WeatherInput): Promise<EngineOutput> {
    const plant = await this.repo.getPlant(plantId);
    if (!plant) throw new Error(`植物不存在：${plantId}`);
    const careRule = await this.repo.getCareRuleByPlant(plantId);
    const history = await this.repo.wateringHistory(plantId);
    return generateRecommendation({
      plant,
      careRule,
      history,
      weather,
      now: this.clock.now(),
    });
  }

  /**
   * 6. 用户确认。
   *
   * 只有 watered 才真的落一条 WateringRecord（闭环的末端回流到历史），
   * 其它动作只写决定日志。
   */
  async confirm(plantId: string, recommendationId: string, action: UserAction): Promise<DecisionLog> {
    const log: DecisionLog = {
      id: nextId('decision'),
      plantId,
      recommendationId,
      action,
      userConfirmedAt: this.clock.now().toISOString(),
    };
    if (action === 'watered') {
      await this.recordWatering(plantId, { entrySource: 'single' });
    }
    return this.repo.recordDecision(log);
  }
}
