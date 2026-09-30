/**
 * 来源说明翻译测试。
 *
 * 核心问题：可追溯性对机器成立还不够，对人也必须成立。
 * 「来源：plant-3」对用户毫无意义，用户要知道的是「哪一条浇水记录」。
 */

import { describe, test, expect } from 'vitest';
import { describeSource, isNavigable } from '../../src/ui/sourceLabel.js';
import type { Reason, WateringRecord, WeatherSnapshot, Plant } from '../../src/domain/types.js';

const plant: Plant = {
  id: 'plant-1',
  name: '龟背竹 A',
  placement: '客厅',
  exposure: 'indoor_window',
  tags: [],
  createdAt: '',
  updatedAt: '',
  version: 1,
};

const history: WateringRecord[] = [
  {
    id: 'water-9',
    plantId: 'plant-1',
    date: '2026-09-21',
    time: '14:20',
    amountMl: 500,
    amountSource: 'user_provided_baseline',
    method: '浇透',
    fertilizerIncluded: false,
    images: [],
    completionState: 'complete',
    entrySource: 'single',
    createdAt: '',
    updatedAt: '',
    version: 1,
  },
];

const weather: WeatherSnapshot = {
  id: 'weather-1',
  city: '广州',
  latitude: 23.11667,
  longitude: 113.25,
  timestamp: '2026-09-30T14:32:00+08:00',
  temperature: 29,
  humidity: 82,
  rainProbability: 70,
  rainfall: 0,
  windSpeed: 2.1,
  sunlight: 4.2,
  weatherCondition: '阴',
  forecast: [],
  provider: 'open-meteo',
};

function reason(over: Partial<Reason>): Reason {
  return { text: '', sourceId: 'x', sourceKind: 'derived', source: 'measured', ...over };
}

describe('来源说明必须是人话，不是内部主键', () => {
  test('浇水记录显示日期时间，不显示 water-9', () => {
    const s = describeSource(reason({ sourceId: 'water-9', sourceKind: 'watering_record' }), {
      plant,
      history,
    });
    expect(s).toContain('浇水记录');
    expect(s).toContain('2026-09-21');
    expect(s).toContain('14:20');
    expect(s).not.toContain('water-9');
  });

  test('天气快照显示城市与时间', () => {
    const s = describeSource(reason({ sourceId: 'weather-1', sourceKind: 'weather' }), { plant, weather });
    expect(s).toContain('天气快照');
    expect(s).toContain('广州');
    expect(s).not.toContain('weather-1');
  });

  test('养护规则标明是用户自己设的', () => {
    const s = describeSource(reason({ sourceKind: 'care_rule' }), { plant });
    expect(s).toContain('你设的');
  });

  test('暴露度依据带上位置名', () => {
    const s = describeSource(reason({ sourceKind: 'exposure' }), { plant });
    expect(s).toContain('客厅');
  });

  test('事实来源性质被标出', () => {
    const s = describeSource(reason({ sourceKind: 'derived', source: 'unknown' }), {});
    expect(s).toContain('未知');
  });

  test('记录找不到时退回通用标签，不暴露空 id', () => {
    const s = describeSource(reason({ sourceId: 'ghost', sourceKind: 'watering_record' }), { history: [] });
    expect(s).toContain('浇水记录');
    expect(s).not.toContain('ghost');
  });

  test('任何情况下都不把 sourceId 原样输出', () => {
    const ids = ['water-9', 'weather-1', 'plant-1', 'ghost-id'];
    for (const id of ids) {
      for (const kind of ['watering_record', 'weather', 'care_rule', 'derived', 'inferred_pattern', 'exposure'] as const) {
        const s = describeSource(reason({ sourceId: id, sourceKind: kind }), { plant, history, weather });
        if (kind === 'watering_record' && id === 'water-9') continue; // 这一条 id 恰好是记录号
        expect(s).not.toContain(id);
      }
    }
  });
});

describe('只有真能核对到记录的来源才给入口', () => {
  test('浇水记录与天气可点开核对', () => {
    expect(isNavigable(reason({ sourceKind: 'watering_record' }))).toBe(true);
    expect(isNavigable(reason({ sourceKind: 'weather' }))).toBe(true);
  });

  test('推断与未知没有对应记录，不给假入口', () => {
    expect(isNavigable(reason({ sourceKind: 'derived' }))).toBe(false);
    expect(isNavigable(reason({ sourceKind: 'inferred_pattern' }))).toBe(false);
    expect(isNavigable(reason({ sourceKind: 'care_rule' }))).toBe(false);
  });
});
