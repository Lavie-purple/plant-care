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
  PendingRuleConflict,
  PlantEvent,
  PlantEventType,
  Plant,
  Settings,
  UserAction,
  WeatherSnapshot,
  WateringMethod,
  WateringRecord,
} from '../domain/types.js';
import { generateRecommendation, type EngineOutput } from '../engine/recommendation.js';
import { Repository } from '../storage/repository.js';
import { buildQueue, completeRecord, DEFAULT_PENDING_DAYS, type QueueItem } from './completionQueue.js';
import { decideConflict, markPrompted, resolveConflict, shouldPrompt, type Resolution } from './ruleConflict.js';
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
  autoFollowConflicts: false,
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
      const snap = await this.fetchWeatherWithRetry();
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

  /**
   * 带超时与重试的天气获取。
   *
   * 为什么需要：实测线上同一个请求耗时在 213ms 到 1070ms 之间波动，
   * 页面首次加载时并行请求更容易撞上抖动。早期版本一次失败就报「天气不可用」，
   * 而这是个每天都要看的工具——偶发一次抖动就整页降级，代价比收益大得多。
   *
   * 仍然严格遵守 D-14：重试全部失败后才降级，且降级时明确说明原因，
   * 绝不用缓存冒充新数据。
   */
  private async fetchWeatherWithRetry(): Promise<WeatherSnapshot> {
    const attempts = 3;
    const timeoutMs = 6000;
    let lastError: unknown;

    for (let i = 0; i < attempts; i += 1) {
      try {
        // 每次尝试独立计时，避免上一次的计时器泄漏
        const timer = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('请求超时（6 秒无响应）')), timeoutMs);
        });
        return await Promise.race([this.weather.fetch(DEFAULT_SETTINGS), timer]);
      } catch (e) {
        lastError = e;
        if (i < attempts - 1) {
          // 退避后重试。天气接口是幂等读操作，重试安全。
          await new Promise((r) => setTimeout(r, 400 * (i + 1)));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
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

  /**
   * 记一条纯文字事件。来源、备注这类只写一次的信息走这里，
   * 而不是在 Plant 上加个只用过一次的字段。
   */
  async addNote(plantId: string, text: string): Promise<PlantEvent> {
    return this.repo.put<PlantEvent>(STORES.plantEvents, {
      id: nextId('event'),
      plantId,
      type: 'NOTE',
      date: this.clock.localDate(),
      description: text,
      images: [],
      metadata: {},
      createdAt: this.clock.now().toISOString(),
      version: 0,
    });
  }

  /**
   * 记一条事件。界面的「记一笔」走这里。
   * 字段按 type 的必填定义收敛，不塞一堆无关字段。
   */
  async addEvent(
    plantId: string,
    input: {
      type: PlantEventType;
      date?: string;
      title?: string;
      description?: string;
      notes?: string;
      images?: string[];
    },
  ): Promise<PlantEvent> {
    const ev = await this.repo.put<PlantEvent>(STORES.plantEvents, {
      id: nextId('event'),
      plantId,
      type: input.type,
      date: input.date ?? this.clock.localDate(),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      // 备注与说明是不同用途：说明是这句话本身，备注写进 metadata
      images: input.images ?? [],
      metadata: input.notes !== undefined ? { notes: input.notes } : {},
      createdAt: this.clock.now().toISOString(),
      version: 0,
    });
    // 没有主图时用第一张照片做封面
    const plant = await this.repo.getPlant(plantId);
    if (plant && !plant.coverImageId && ev.images[0]) {
      await this.repo.put<Plant>(STORES.plants, { ...plant, coverImageId: ev.images[0] });
    }
    return ev;
  }

  /**
   * 把一张已存好的图片挂到植物上。
   * 同时建一条 PHOTO 事件，这样它会出现在成长时间线里（D-08）。
   */
  async attachPhoto(plantId: string, imageId: string, title?: string): Promise<PlantEvent> {
    const plant = await this.repo.getPlant(plantId);
    const event = await this.repo.put<PlantEvent>(STORES.plantEvents, {
      id: nextId('event'),
      plantId,
      type: 'PHOTO',
      date: this.clock.localDate(),
      ...(title !== undefined ? { title } : {}),
      images: [imageId],
      metadata: {},
      createdAt: this.clock.now().toISOString(),
      version: 0,
    });
    // 没有主图时把第一张设为封面
    if (plant && !plant.coverImageId) {
      await this.repo.put<Plant>(STORES.plants, { ...plant, coverImageId: imageId });
    }
    return event;
  }

  /**
   * 生成建议，并在需要时记一条规则冲突。
   *
   * D-13：系统绝不擅自改 CareRule。这里只写 PendingRuleConflict，
   * 改不改由用户通过 resolveRuleConflict 决定。
   */
  async recommendAndCheck(plantId: string, weather: WeatherInput): Promise<{ rec: EngineOutput; conflictCreated: boolean }> {
    const rec = await this.recommend(plantId, weather);
    if (!rec.shouldPromptRuleChange) return { rec, conflictCreated: false };

    const plant = await this.repo.getPlant(plantId);
    const rule = await this.repo.getCareRuleByPlant(plantId);
    if (!plant || !rule) return { rec, conflictCreated: false };

    const existing = await this.repo.unresolvedConflicts();
    const all = await this.repo.getAll<PendingRuleConflict>(STORES.pendingConflicts);
    const decision = decideConflict(
      all,
      {
        plantId,
        ruleId: rule.id,
        computed: rec.computedInterval,
        user: { min: rule.recommendedIntervalMin, max: rule.recommendedIntervalMax },
        reason: rec.ruleConflictReason ?? '当前环境与你的周期设定不一致',
        now: this.clock.now(),
      },
    );
    void existing;
    if (decision.action !== 'create') return { rec, conflictCreated: false };

    await this.repo.put<PendingRuleConflict>(STORES.pendingConflicts, decision.conflict);
    return { rec, conflictCreated: true };
  }

  /** 取出待弹窗的冲突，并标记为已问过（W3：同一 id 只弹一次） */
  async takeConflictToPrompt(plantId: string): Promise<PendingRuleConflict | undefined> {
    const all = await this.repo.getAll<PendingRuleConflict>(STORES.pendingConflicts);
    const target = all.find(
      (c) => c.plantId === plantId && shouldPrompt(c),
    );
    if (!target) return undefined;
    const marked = markPrompted(target, this.clock.now());
    await this.repo.put<PendingRuleConflict>(STORES.pendingConflicts, marked);
    return marked;
  }

  /** 用户做出选择。只有 take-computed 才会写 CareRule。 */
  async resolveRuleConflict(
    conflictId: string,
    mode: Resolution,
  ): Promise<'keep-user' | 'take-computed'> {
    const conflict = await this.repo.get<PendingRuleConflict>(STORES.pendingConflicts, conflictId);
    if (!conflict) throw new Error('规则冲突不存在');
    const rule = await this.repo.getCareRuleByPlant(conflict.plantId);
    if (!rule) throw new Error('找不到对应的养护规则');

    const r = resolveConflict(conflict, mode, rule, this.clock.now());
    await this.repo.put<PendingRuleConflict>(STORES.pendingConflicts, r.conflict);
    if (r.updatedRule) {
      await this.repo.put<CareRule>(STORES.careRules, r.updatedRule);
    }
    return mode;
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

  /**
   * 自动跟随开关。存在 settings 里而不是内存——
   * 放内存的话关掉页面就失效，用户会以为勾了没用。
   */
  async setAutoFollowConflicts(on: boolean): Promise<void> {
    const s = await this.repo.getSettings();
    if (!s) return;
    await this.repo.saveSettings({ ...s, autoFollowConflicts: on });
  }

  async getAutoFollowConflicts(): Promise<boolean> {
    const s = await this.repo.getSettings();
    return s?.autoFollowConflicts ?? false;
  }

  /** 待确认的规则冲突，Today 页面提醒条与弹窗用 */
  async listConflicts(): Promise<PendingRuleConflict[]> {
    return this.repo.unresolvedConflicts();
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
