/**
 * 示例数据生成器。
 *
 * 用途：判定页与习惯页需要历史数据才有内容，而真实数据要积累几周。
 * 这里造一批**明确标注为示例**的数据，让功能可以立刻看到、立刻测。
 *
 * 三条硬规矩：
 *   1. 示例数据带 demo 标记，界面上必须显式说明这是示例，不能冒充真实。
 *   2. 只在用户明确点击「生成示例数据」时写入，不自动播种。
 *      早先 main.tsx 自动播种的做法已经删掉了，理由见 MUTATION.md。
 *   3. 生成时用固定种子，同样的操作得到同样的数据，便于复现。
 */

import type { CareRule, DecisionLog, Exposure, Placement, Plant, UserAction, WateringMethod, WateringRecord } from '../domain/types.js';

export interface DemoSpec {
  key: string;
  name: string;
  species: string;
  placement: Placement;
  exposure: Exposure;
  intervalMin: number;
  intervalMax: number;
  /** 首次浇水距今多少天 */
  firstWaterAgo: number;
  /** 后续浇水间隔的典型长度，天 */
  rhythm: number;
  /** 从最后一次往前推的浇水次数 */
  times: number;
  potDiameterCm: number;
  tags: string[];
}

export const DEMO_SPECS: DemoSpec[] = [
  { key: 'd1', name: '龟背竹 A（示例）', species: '龟背竹', placement: '客厅', exposure: 'indoor_window', intervalMin: 7, intervalMax: 10, firstWaterAgo: 26, rhythm: 9, times: 4, potDiameterCm: 18, tags: ['客厅绿植', '大叶'] },
  { key: 'd2', name: '薄荷（示例）', species: '薄荷', placement: '阳台', exposure: 'outdoor', intervalMin: 3, intervalMax: 5, firstWaterAgo: 20, rhythm: 4, times: 6, potDiameterCm: 14, tags: ['可食用'] },
  { key: 'd3', name: '琴叶榕 B（示例）', species: '琴叶榕', placement: '客厅', exposure: 'indoor_window', intervalMin: 10, intervalMax: 14, firstWaterAgo: 15, rhythm: 11, times: 2, potDiameterCm: 22, tags: ['大叶'] },
  { key: 'd4', name: '多肉 C（示例）', species: '景天科多肉', placement: '书房', exposure: 'indoor', intervalMin: 14, intervalMax: 20, firstWaterAgo: 12, rhythm: 16, times: 1, potDiameterCm: 10, tags: ['耐旱'] },
  { key: 'd5', name: '虎尾兰（示例）', species: '虎尾兰', placement: '阳台', exposure: 'semi_outdoor', intervalMin: 14, intervalMax: 18, firstWaterAgo: 9, rhythm: 15, times: 0, potDiameterCm: 16, tags: ['耐旱'] },
  { key: 'd6', name: '白掌（示例）', species: '白掌', placement: '卧室', exposure: 'indoor', intervalMin: 5, intervalMax: 7, firstWaterAgo: 3, rhythm: 6, times: 3, potDiameterCm: 15, tags: ['净化空气'] },
];

export interface DemoOutput {
  plants: Plant[];
  careRules: (CareRule & { id: string })[];
  wateringRecords: (WateringRecord & { id: string })[];
  decisionLogs: (DecisionLog & { id: string })[];
  photos: { id: string; plantId: string; date: string; title: string }[];
  notes: string[];
}

function iso(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}T${hh}:${mm}:00+08:00`;
}

function dateOf(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * 生成示例数据。确定性：同样的 today 与 specs 得到同样的结果。
 */
export function buildDemoData(today: Date): DemoOutput {
  const plants: DemoOutput['plants'] = [];
  const careRules: DemoOutput['careRules'] = [];
  const wateringRecords: DemoOutput['wateringRecords'] = [];
  const decisionLogs: DemoOutput['decisionLogs'] = [];
  const photos: DemoOutput['photos'] = [];

  const METHODS: WateringMethod[] = ['浇透', '喷雾', '浸盆'];

  for (const spec of DEMO_SPECS) {
    const pid = `demo-${spec.key}`;
    plants.push({
      id: pid,
      name: spec.name,
      species: spec.species,
      placement: spec.placement,
      exposure: spec.exposure,
      potDiameterCm: spec.potDiameterCm,
      tags: spec.tags,
      createdAt: iso(today),
      updatedAt: iso(today),
      version: 1,
    });
    careRules.push({
      id: `demo-rule-${spec.key}`,
      plantId: pid,
      recommendedIntervalMin: spec.intervalMin,
      recommendedIntervalMax: spec.intervalMax,
      minimumInterval: Math.max(1, Math.floor(spec.intervalMin * 0.7)),
      maximumInterval: Math.ceil(spec.intervalMax * 1.3),
      source: 'user',
      userOverride: true,
      updatedAt: iso(today),
      version: 1,
    });

    // 浇水记录：从最后一次往前推，每次间隔 rhythm 天
    for (let i = 0; i <= spec.times; i += 1) {
      const daysAgo = spec.firstWaterAgo + i * spec.rhythm;
      if (daysAgo > 400) continue;
      const at = new Date(today);
      at.setDate(at.getDate() - daysAgo);
      at.setHours(19, 0, 0, 0);
      const rid = `demo-w-${spec.key}-${i}`;
      wateringRecords.push({
        id: rid,
        plantId: pid,
        date: dateOf(at),
        time: '19:00',
        amountMl: Math.round((spec.potDiameterCm / 18) ** 3 * 500),
        amountSource: 'user_provided_baseline',
        method: METHODS[i % METHODS.length] ?? '浇透',
        fertilizerIncluded: i % 4 === 0,
        images: [],
        completionState: 'complete',
        entrySource: 'bulk',
        createdAt: iso(at),
        updatedAt: iso(at),
        version: 1,
      });

      // 部分记录带决定日志，让习惯页有内容
      if (i % 3 === 0) {
        decisionLogs.push({
          id: `demo-d-${spec.key}-${i}`,
          plantId: pid,
          recommendationId: `demo-rec-${spec.key}-${i}`,
          action: (['confirm', 'delay', 'skip', 'judged_no_need'] as UserAction[])[i % 4] ?? 'confirm',
          userConfirmedAt: iso(at),
        });
      }
    }

    // 一张成长照片记录
    const photoAt = new Date(today);
    photoAt.setDate(photoAt.getDate() - spec.firstWaterAgo - 3);
    photos.push({ id: `demo-photo-${spec.key}`, plantId: pid, date: dateOf(photoAt), title: '长势记录' });
  }

  return {
    plants,
    careRules,
    wateringRecords,
    decisionLogs,
    photos,
    notes: [
      '已生成示例数据：6 盆植物、若干浇水记录与决定日志。',
      '这些是为演示判定页与习惯页造的假数据，不是真实养护记录。',
      '要删除它们：在「备份」页选择「完全替换」导入你之前导出的文件，或在浏览器设置里清除本站数据。',
    ],
  };
}
