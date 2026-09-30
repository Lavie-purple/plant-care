/**
 * 推荐引擎。
 *
 * 硬约束（AGENTS.md + 决策记录）：
 *   1. 纯函数。不发网络请求，不读时钟，不调用 AI。所有外部输入靠参数传入。
 *   2. 绝不写 CareRule。系统算出的周期只能进 PendingRuleConflict。
 *      断言：注入任何天气数据后，careRule.recommendedIntervalMin/Max 必须逐字节不变。
 *   3. 每条 reason 必须带 sourceId。无法追溯的判断不允许输出。
 *   4. 天气不可用时降级运行，显式标记 weatherUnavailable，绝不假装有数据。
 */

import type {
  Action,
  CareRule,
  EntityId,
  Exposure,
  Plant,
  Reason,
  Recommendation,
  WeatherInput,
  WateringRecord,
} from '../domain/types.js';

// ============================================================
// 暴露度表（D-03）
// ============================================================

const EXPOSURE_PROFILES: Record<Exposure, { rainFactor: number; lightFactor: number; tempVariance: number }> = {
  // 完全不受降雨影响
  indoor: { rainFactor: 0, lightFactor: 0.6, tempVariance: 0.3 },
  // 靠窗，可能接到一点飘雨
  indoor_window: { rainFactor: 0.15, lightFactor: 0.85, tempVariance: 0.5 },
  // 半户外，下雨会被淋到
  semi_outdoor: { rainFactor: 0.7, lightFactor: 1.0, tempVariance: 0.8 },
  // 露天，完全暴露
  outdoor: { rainFactor: 1, lightFactor: 1.0, tempVariance: 1.0 },
};

// ============================================================
// 参数（可断言的硬阈值，非「看起来对不对」）
// ============================================================

export const THRESHOLDS = {
  /** 低于此降雨概率视为「基本不下雨」 */
  RAIN_PROBABLE: 40,
  /** 高于此概率视为「大概率下雨」 */
  RAIN_LIKELY: 60,
  /** 高于此相对湿度视为潮湿，土壤干得慢 */
  HUMIDITY_HIGH: 75,
  /** 低于此相对湿度视为偏干 */
  HUMIDITY_LOW: 45,
  /** 高于此温度视为高温，蒸腾加速 */
  TEMP_HIGH: 30,
  /** 高温最多把浇水窗口提前这么多天 */
  HEAT_ADVANCE_DAYS: 1,
  /** 高于此风速视为大风，加速失水 */
  WIND_HIGH: 6,
  /** D-11：历史样本少于这个数，引擎只输出 CHECK，不给浇水建议 */
  MIN_SAMPLES_FOR_INFERENCE: 3,
  /** DELAY 的建议延后天数上下限 */
  DELAY_MIN_DAYS: 1,
  DELAY_MAX_DAYS: 3,
} as const;

// ============================================================
// 输入
// ============================================================

export interface EngineInput {
  plant: Plant;
  /** 用户未设定周期时为 undefined，引擎降级为按历史推断（D-11） */
  careRule?: CareRule | undefined;
  /** 按时间倒序或正序均可，引擎内部会排序 */
  history: WateringRecord[];
  weather: WeatherInput;
  /** 生成时刻，由调用方传入，引擎不读时钟 */
  now: Date;
  /** 排除尚未完成的补录记录（它们不代表真实浇水） */
  includePending?: boolean;
}

export interface EngineOutput {
  recommendation: Omit<Recommendation, 'id' | 'version' | 'userConfirmed'>;
  /** 距上次浇水的天数，界面显示用。没有记录时为 undefined */
  daysSince: number | undefined;
  /** 引擎算出的周期。用户设定与它不一致时，由调用方写 PendingRuleConflict。 */
  computedInterval: { min: number; max: number };
  /** 该不该提示用户「要不要调整周期」 */
  shouldPromptRuleChange: boolean;
  ruleConflictReason?: string;
}

// ============================================================
// 工具
// ============================================================

/**
 * 把一条浇水记录解析成绝对时刻。
 *
 * 必须用记录的 date 字段做基准，只取 time 的时分。
 * 早先的写法把 now 当基准，等于把所有历史记录都当成「今天」，daysSince 恒为 0。
 */
function recordDate(w: WateringRecord): Date {
  const [y, m, d] = w.date.split('-').map(Number);
  const [hh, mm] = w.time.split(':').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0, 0, 0);
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

/** 连续降雨天数。用于「这几天持续有雨」这类判断。 */
function consecutiveRainDays(forecast: { rainProbability: number }[]): number {
  let count = 0;
  for (const h of forecast) {
    if (h.rainProbability >= THRESHOLDS.RAIN_LIKELY) count += 1;
    else break;
  }
  return count;
}

export function exposureProfile(exposure: Exposure) {
  return EXPOSURE_PROFILES[exposure];
}

// ============================================================
// 主函数
// ============================================================

export function generateRecommendation(input: EngineInput): EngineOutput {
  const { plant, careRule, weather, now } = input;
  const profile = EXPOSURE_PROFILES[plant.exposure];

  const history = [...input.history]
    .filter((w) => input.includePending === true || w.completionState === 'complete')
    .sort((a, b) => recordDate(b).getTime() - recordDate(a).getTime());

  const reasons: Reason[] = [];
  const last = history[0];
  const lastAt = last ? recordDate(last) : undefined;
  const daysSince = last && lastAt ? Math.max(0, daysBetween(lastAt, now)) : undefined;

  // ---- 1. 决定参考周期 ----
  // 优先级：用户设定 > 用户历史推断。绝不用外部数据覆盖用户（D-13 铁律）
  const historyIntervals = computeIntervals(history, now);
  const inferred = inferInterval(historyIntervals);

  const baseInterval = pickBaseInterval(careRule, inferred);

  if (!baseInterval) {
    // 既无用户设定，历史也不足。D-11：只给 CHECK，不猜。
    reasons.push({
      text: `还没有任何可参考的周期数据。这株植物建档后还没有浇水记录，或者记录不足 ${THRESHOLDS.MIN_SAMPLES_FOR_INFERENCE} 次。`,
      sourceId: plant.id,
      sourceKind: 'derived',
      source: 'unknown',
    });
    return finish('CHECK', 0.2, reasons, {
      plantId: plant.id,
      now,
      daysSince,
      suggestedAction: '先记一次浇水，或手动设定一个周期',
      basedOn: {
        wateringCount: history.length,
        weatherUnavailable: !weather.available,
        ...(last ? { lastWateringId: last.id } : {}),
        ...(careRule ? { careRuleId: careRule.id } : {}),
        ...(weather.available ? { weatherSnapshotId: weather.snapshot.id } : {}),
      },
    });
  }

  // ---- 2. 逐条产出依据 ----
  if (daysSince !== undefined && last) {
    reasons.push({
      text:
        baseInterval.origin === 'user'
          ? `距上次浇水 ${daysSince} 天，你设定的周期是 ${baseInterval.min} 到 ${baseInterval.max} 天。`
          : `距上次浇水 ${daysSince} 天。这株植物的周期由它自己的 ${historyIntervals.length} 次记录推断，范围 ${baseInterval.min} 到 ${baseInterval.max} 天。`,
      sourceId: last.id,
      sourceKind: 'watering_record',
      source: 'measured',
    });
  } else {
    reasons.push({
      text: '这株植物还没有浇水记录。',
      sourceId: plant.id,
      sourceKind: 'derived',
      source: 'unknown',
    });
  }

  if (historyIntervals.length >= THRESHOLDS.MIN_SAMPLES_FOR_INFERENCE) {
    reasons.push({
      text: `过去 ${historyIntervals.length} 次间隔为 ${historyIntervals.join('、')} 天，中位数 ${median(historyIntervals)} 天。`,
      sourceId: last?.id ?? plant.id,
      sourceKind: 'inferred_pattern',
      source: 'inferred',
    });
  }

  // ---- 3. 天气影响 ----
  let delayDays: number | undefined;
  let rainReliefDays = 0;
  let heatPressureDays = 0;

  if (weather.available) {
    const w = weather.snapshot;
    const effectiveRain = w.rainProbability * profile.rainFactor;

    reasons.push({
      text:
        `当前 ${w.temperature}°C，相对湿度 ${w.humidity}%，${plant.exposure === 'indoor' || plant.exposure === 'indoor_window' ? '该位置在室内或靠窗，不直接受降雨影响' : `该位置为${exposureLabel(plant.exposure)}，受降雨影响系数 ${profile.rainFactor}`}。`,
      sourceId: w.id,
      sourceKind: 'weather',
      source: 'measured',
    });

    // 降雨缓解：仅在暴露度允许时生效
    if (effectiveRain >= THRESHOLDS.RAIN_LIKELY) {
      rainReliefDays = consecutiveRainDays(w.forecast) >= 2 ? 2 : 1;
      reasons.push({
        text: `未来两天降雨概率偏高（有效值 ${Math.round(effectiveRain)}%），土壤干得慢。`,
        sourceId: w.id,
        sourceKind: 'weather',
        source: 'measured',
      });
    } else if (effectiveRain < THRESHOLDS.RAIN_PROBABLE) {
      reasons.push({
        text: '未来两天基本无有效降雨，盆土会继续变干。',
        sourceId: w.id,
        sourceKind: 'weather',
        source: 'measured',
      });
    }

    // 高温 + 大风：提前
    if (w.temperature >= THRESHOLDS.TEMP_HIGH) {
      heatPressureDays = THRESHOLDS.HEAT_ADVANCE_DAYS;
      reasons.push({
        text: `当前 ${w.temperature}°C 高于 ${THRESHOLDS.TEMP_HIGH}°C，蒸腾加速，盆土干得比平时快。`,
        sourceId: w.id,
        sourceKind: 'weather',
        source: 'measured',
      });
    }
    if (w.windSpeed >= THRESHOLDS.WIND_HIGH) {
      heatPressureDays = THRESHOLDS.HEAT_ADVANCE_DAYS;
      reasons.push({
        text: `风速 ${w.windSpeed} m/s，加速水分蒸发。`,
        sourceId: w.id,
        sourceKind: 'weather',
        source: 'measured',
      });
    }
    // 湿度只作为佐证，不单独驱动延期。
    // 潮湿不等于该等：真正让盆土重新变湿的是降雨，不是空气湿度。
    // 早期版本在这里设 rainReliefDays，导致室内植物在高湿天被无端建议延后。
    if (w.humidity >= THRESHOLDS.HUMIDITY_HIGH) {
      reasons.push({
        text: `相对湿度 ${w.humidity}% 偏高，蒸发慢；${rainReliefDays > 0 ? '已计入延期理由。' : '但不足以单独构成延后理由，延期只看降雨。'}`,
        sourceId: w.id,
        sourceKind: 'weather',
        source: 'measured',
      });
    }
  } else {
    // D-14：天气失败必须显式降级，不能假装有数据
    reasons.push({
      text: `天气数据暂不可用（${weather.fallback.reason}）。本次判断只依据上次浇水时间、植物规则和历史记录。`,
      sourceId: plant.id,
      sourceKind: 'derived',
      source: 'unknown',
    });
  }

  // ---- 4. 判定 ----
  let action: Action;
  // 没有浇水记录 ≠ 0 天前浇过。早期版本把两者都当 d=0，
  // 导致刚建档、从未浇过的植物被判为「无需处理」，
  // 而这恰恰是用户最需要被提醒的情况（痛点第一条：记不住上次什么时候浇水）。
  if (daysSince === undefined) {
    action = 'CHECK';
    reasons.push({
      text: `这株植物还没有浇水记录，无法判断是否该浇。先记一次，或直接看盆土。${baseInterval.origin === 'user' ? `你设定的周期是 ${baseInterval.min} 到 ${baseInterval.max} 天。` : ''}`,
      sourceId: plant.id,
      sourceKind: 'derived',
      source: 'unknown',
    });
  } else {
    const d = daysSince;
    if (d >= baseInterval.max) {
      // 超出推荐周期上限。到了该动手的时点。
      if (rainReliefDays > 0) {
        action = 'DELAY';
        delayDays = clamp(rainReliefDays, THRESHOLDS.DELAY_MIN_DAYS, THRESHOLDS.DELAY_MAX_DAYS);
      } else {
        action = 'WATER_NOW';
      }
    } else if (d >= baseInterval.min) {
      // 刚进入推荐周期。此时浇水不算错但也谈不上该浇，建议先看盆土。
      action = 'CHECK';
    } else if (d >= baseInterval.min - THRESHOLDS.HEAT_ADVANCE_DAYS && heatPressureDays > 0) {
      // 未到周期下限，但高温把窗口提前了
      action = 'CHECK';
      reasons.push({
        text: `距上次浇水 ${d} 天，未到 ${baseInterval.min} 天周期下限，但当前高温让盆土干得比平时快，建议先检查。`,
        sourceId: last?.id ?? plant.id,
        sourceKind: 'derived',
        source: 'measured',
      });
    } else {
      action = 'NO_ACTION';
      delayDays = undefined;
      reasons.push({
        text: `距上次浇水只有 ${d} 天，未到最短周期 ${baseInterval.min} 天，不建议现在浇水。`,
        sourceId: last?.id ?? plant.id,
        sourceKind: 'derived',
        source: 'measured',
      });
    }
  }

  // ---- 5. 建议的周期 vs 用户设定 ----
  // 系统可以算，但不能改。只提示。这是 D-13 的铁律落地点。
  const computed = {
    min: baseInterval.min + heatPressureDays - rainReliefDays,
    max: baseInterval.max + heatPressureDays - rainReliefDays,
  };
  const shouldPrompt =
    baseInterval.origin === 'user' && (computed.min !== baseInterval.min || computed.max !== baseInterval.max);
  const ruleConflictReason =
    heatPressureDays > 0
      ? `未来几天高温${profile.tempVariance >= 0.8 ? '且该位置在户外，风与日照都会加速失水' : ''}，蒸腾量上升。`
      : rainReliefDays > 0
        ? `近期湿度偏高且有降雨${profile.rainFactor > 0.5 ? '，该位置会被直接淋到' : ''}，周期可以适当延长。`
        : undefined;

  return finish(action, confidenceFor(action, history.length, weather.available), reasons, {
    plantId: plant.id,
    now,
    daysSince,
    suggestedAction: suggestedText(action, delayDays),
    ...(delayDays !== undefined ? { suggestedDelayDays: delayDays } : {}),
    basedOn: {
      wateringCount: history.length,
      weatherUnavailable: !weather.available,
      ...(last ? { lastWateringId: last.id } : {}),
      ...(careRule ? { careRuleId: careRule.id } : {}),
      ...(weather.available ? { weatherSnapshotId: weather.snapshot.id } : {}),
    },
    computedInterval: computed,
    shouldPromptRuleChange: shouldPrompt,
    ...(ruleConflictReason !== undefined ? { ruleConflictReason } : {}),
  });
}

// ============================================================
// 内部
// ============================================================

interface BaseInterval {
  min: number;
  max: number;
  origin: 'user' | 'inferred';
}

function pickBaseInterval(careRule: CareRule | undefined, inferred: BaseInterval | undefined): BaseInterval | undefined {
  // D-13 铁律：用户设定永远优先，且系统永不覆盖它
  if (careRule) {
    return { min: careRule.recommendedIntervalMin, max: careRule.recommendedIntervalMax, origin: 'user' };
  }
  return inferred;
}

function computeIntervals(history: WateringRecord[], now: Date): number[] {
  const sorted = [...history].sort((a, b) => recordDate(a).getTime() - recordDate(b).getTime());
  const out: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (!prev || !cur) continue;
    const days = daysBetween(recordDate(prev), recordDate(cur));
    if (days > 0) out.push(days);
  }
  return out;
}

function inferInterval(intervals: number[]): BaseInterval | undefined {
  if (intervals.length < THRESHOLDS.MIN_SAMPLES_FOR_INFERENCE) return undefined;
  const med = median(intervals);
  return { min: Math.max(1, med - 2), max: med + 2, origin: 'inferred' };
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const a = s[mid];
  const b = s[mid - 1];
  if (s.length % 2 === 0 && a !== undefined && b !== undefined) return Math.round((a + b) / 2);
  return a ?? 0;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function exposureLabel(e: Exposure): string {
  return { indoor: '室内', indoor_window: '室内靠窗', semi_outdoor: '半户外', outdoor: '露天' }[e];
}

function confidenceFor(action: Action, samples: number, weatherAvailable: boolean): number {
  let base: number;
  switch (action) {
    case 'WATER_NOW':
      base = 0.75;
      break;
    case 'CHECK':
      base = 0.6;
      break;
    case 'DELAY':
      base = 0.65;
      break;
    case 'NO_ACTION':
      base = 0.55;
      break;
  }
  if (samples >= 5) base += 0.1;
  if (!weatherAvailable) base -= 0.2;
  return Math.round(Math.min(0.95, Math.max(0.1, base)) * 100) / 100;
}

function suggestedText(action: Action, delayDays: number | undefined): string {
  switch (action) {
    case 'WATER_NOW':
      return '建议今天浇水，浇透。';
    case 'DELAY':
      return `建议暂缓浇水 ${delayDays ?? 1} 天，先看盆土。`;
    case 'CHECK':
      return '建议检查盆土。';
    case 'NO_ACTION':
      return '暂时无需处理。';
  }
}

function finish(
  action: Action,
  confidence: number,
  reasons: Reason[],
  extra: {
    plantId: EntityId;
    now: Date;
    daysSince: number | undefined;
    suggestedAction: string;
    suggestedDelayDays?: number;
    basedOn: Recommendation['basedOn'];
    computedInterval?: { min: number; max: number };
    shouldPromptRuleChange?: boolean;
    ruleConflictReason?: string;
  },
): EngineOutput {
  // 不变量 1 的运行时兜底：没有 sourceId 的依据不允许离开引擎
  for (const r of reasons) {
    if (!r.sourceId) throw new Error('Reason 缺少 sourceId，无法追溯，拒绝输出');
  }

  return {
    recommendation: {
      plantId: extra.plantId,
      generatedAt: extra.now.toISOString(),
      action,
      confidence,
      reasons,
      suggestedAction: extra.suggestedAction,
      ...(extra.suggestedDelayDays !== undefined ? { suggestedDelayDays: extra.suggestedDelayDays } : {}),
      basedOn: extra.basedOn,
    },
    daysSince: extra.daysSince,
    computedInterval: extra.computedInterval ?? { min: 0, max: 0 },
    shouldPromptRuleChange: extra.shouldPromptRuleChange ?? false,
    ...(extra.ruleConflictReason !== undefined ? { ruleConflictReason: extra.ruleConflictReason } : {}),
  };
}
