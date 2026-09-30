/**
 * 把依据的 sourceId 翻译成人能读懂的来源说明。
 *
 * 可追溯性对机器成立还不够，对人也必须成立。
 * 直接显示「来源：plant-3」等于把内部主键甩给用户看，
 * 用户点进去也不知道会看到什么。可追溯的真正含义是
 * 「用户能核对到具体那一条记录」。
 */

import type { Plant, WateringRecord, WeatherSnapshot } from '../domain/types.js';
import type { Reason } from '../domain/types.js';

export interface SourceContext {
  plant?: Plant;
  history?: WateringRecord[];
  weather?: WeatherSnapshot;
  /** D-13：18cm 盆 500ml 的估算口径，界面上要能原样显示 */
  baselineNote?: string;
}

const KIND_LABEL: Record<Reason['sourceKind'], string> = {
  watering_record: '浇水记录',
  weather: '天气快照',
  care_rule: '养护规则',
  derived: '推断',
  inferred_pattern: '历史规律',
  exposure: '摆放位置',
};

const SOURCE_LABEL: Record<Reason['source'], string> = {
  measured: '实测',
  user_stated: '你填的',
  user_provided_baseline: '经验基线',
  inferred: '推断',
  unknown: '未知',
};

/**
 * 生成一行人类可读的来源说明。
 * 例：「浇水记录 09-21 14:20 · 实测」
 */
export function describeSource(reason: Reason, ctx: SourceContext): string {
  const kind = KIND_LABEL[reason.sourceKind];
  const nature = SOURCE_LABEL[reason.source];

  switch (reason.sourceKind) {
    case 'watering_record': {
      const rec = ctx.history?.find((w) => w.id === reason.sourceId);
      if (!rec) return `${kind} · ${nature}`;
      return `${kind} ${rec.date} ${rec.time} · ${nature}`;
    }
    case 'weather': {
      const w = ctx.weather;
      if (!w || w.id !== reason.sourceId) return `${kind} · ${nature}`;
      const t = new Date(w.timestamp);
      const hh = String(t.getHours()).padStart(2, '0');
      const mm = String(t.getMinutes()).padStart(2, '0');
      return `${kind} ${w.city} ${hh}:${mm} · ${nature}`;
    }
    case 'care_rule':
      return `${kind}（你设的）`;
    case 'exposure':
      return `${kind}（${ctx.plant?.placement ?? '未知'}）`;
    case 'inferred_pattern':
      return `${kind} · 依据你过去的记录`;
    case 'derived':
      return ctx.baselineNote ? `${kind} · ${ctx.baselineNote}` : `${kind} · ${nature}`;
  }
}

/**
 * 判断这条来源是否值得让用户点进去。
 * 「推断」和「未知」没有对应的原始记录可核对，不给假入口。
 */
export function isNavigable(reason: Reason): boolean {
  return reason.sourceKind === 'watering_record' || reason.sourceKind === 'weather';
}
