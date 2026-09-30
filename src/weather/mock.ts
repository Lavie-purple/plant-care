/**
 * Mock 天气源。
 *
 * 存在的理由不是「省事」，而是让整条闭环的测试完全不依赖网络。
 * 真实天气服务会限流、会挂、会在写测试时超时。闭环测试必须能在
 * 任何网络状态下重复跑出同样结果。
 */

import type { Settings, WeatherSnapshot } from '../domain/types.js';
import { WeatherFetchError, type WeatherProvider } from './provider.js';

export interface MockScenario {
  temperature: number;
  humidity: number;
  rainProbability: number;
  rainfall: number;
  windSpeed: number;
  sunlight: number;
  weatherCondition: string;
  /** 未来逐小时，默认给 48 小时 */
  forecast?: { temperature: number; humidity: number; rainProbability: number; precipitation: number }[];
}

/** 常用场景，避免每个测试都手写一整套 */
export const SCENARIOS = {
  /** 阴雨潮湿：室内应判定不延期，露台应延期 */
  humidRainy: {
    temperature: 29,
    humidity: 85,
    rainProbability: 80,
    rainfall: 12,
    windSpeed: 2.1,
    sunlight: 2.5,
    weatherCondition: '中雨',
  },
  /** 炎热干燥：任何位置都该加速失水 */
  hotDry: {
    temperature: 35,
    humidity: 32,
    rainProbability: 5,
    rainfall: 0,
    windSpeed: 7.5,
    sunlight: 9.2,
    weatherCondition: '晴',
  },
  /** 普通天气 */
  mild: {
    temperature: 26,
    humidity: 60,
    rainProbability: 20,
    rainfall: 0,
    windSpeed: 2,
    sunlight: 5,
    weatherCondition: '多云',
  },
} satisfies Record<string, MockScenario>;

export class MockWeatherProvider implements WeatherProvider {
  readonly name = 'mock';

  private scenario: MockScenario;
  private cached: WeatherSnapshot | undefined;
  /** 设为 true 时 fetch 必定抛错，用于测试降级路径 */
  failWith: string | undefined;
  /** 统计调用次数，测试可断言缓存逻辑 */
  fetchCount = 0;

  constructor(scenario: MockScenario = SCENARIOS.mild) {
    this.scenario = scenario;
  }

  setScenario(s: MockScenario): void {
    this.scenario = s;
  }

  setFailure(reason: string | undefined): void {
    this.failWith = reason;
  }

  async fetch(settings: Settings): Promise<WeatherSnapshot> {
    this.fetchCount += 1;
    if (this.failWith) {
      throw new WeatherFetchError(this.name, this.failWith);
    }
    return this.build(settings);
  }

  async readCache(_settings: Settings): Promise<WeatherSnapshot | undefined> {
    return this.cached;
  }

  async writeCache(snapshot: WeatherSnapshot): Promise<void> {
    this.cached = snapshot;
  }

  private build(settings: Settings): WeatherSnapshot {
    const s = this.scenario;
    // D-14：默认拉 48 小时逐小时预报。没有显式 forecast 时，
    // 用当前场景逐时重复，保证下游 always 拿到 48 条。
    const hours: { temperature: number; humidity: number; rainProbability: number; precipitation: number }[] =
      s.forecast ??
      Array.from({ length: 48 }, () => ({
        temperature: s.temperature,
        humidity: s.humidity,
        rainProbability: s.rainProbability,
        precipitation: s.rainfall,
      }));
    const now = new Date();

    return {
      id: `mock-${now.getTime()}`,
      city: settings.city,
      latitude: settings.latitude,
      longitude: settings.longitude,
      timestamp: now.toISOString(),
      temperature: s.temperature,
      humidity: s.humidity,
      rainProbability: s.rainProbability,
      rainfall: s.rainfall,
      windSpeed: s.windSpeed,
      sunlight: s.sunlight,
      weatherCondition: s.weatherCondition,
      forecast: hours.map((h, i) => ({
        timestamp: new Date(now.getTime() + i * 3_600_000).toISOString(),
        temperature: h.temperature,
        humidity: h.humidity,
        rainProbability: h.rainProbability,
        precipitation: h.precipitation,
      })),
      provider: this.name,
    };
  }
}
