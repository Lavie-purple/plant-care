/**
 * Open-Meteo 天气源（D-14）。
 *
 * 无需 API key。字段名与单位均依据 2026-09-30 的真实接口响应核对，未凭记忆书写。
 *
 * 已核对的真实响应结构：
 *   current.temperature_2m        °C
 *   current.relative_humidity_2m  %
 *   current.precipitation         mm
 *   current.wind_speed_10m        km/h   ← 注意是 km/h，不是 m/s
 *   current.weather_code          WMO code
 *   hourly.precipitation_probability %
 *   daily.sunshine_duration       秒     ← 注意是秒，不是小时
 *   utc_offset_seconds            28800
 *
 * 单位换算是硬约束：引擎里的阈值是按 m/s 和小时算的，换算错会让高温和大风规则失效。
 */

import type { ForecastHour, Settings, WeatherSnapshot } from '../domain/types.js';
import { WeatherFetchError, type WeatherProvider } from './provider.js';

const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';

/** km/h → m/s */
const KMH_TO_MS = 1 / 3.6;

/** WMO weather code → 中文描述。只覆盖养护相关的常见码，不编造。 */
const WMO: Record<number, string> = {
  0: '晴',
  1: '大部晴朗',
  2: '局部多云',
  3: '阴',
  45: '雾',
  48: '雾凇',
  51: '小毛毛雨',
  53: '毛毛雨',
  55: '大毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  80: '阵雨',
  81: '强阵雨',
  82: '暴雨',
  95: '雷雨',
  96: '雷雨伴冰雹',
  99: '强雷雨伴冰雹',
};

interface OpenMeteoResponse {
  latitude: number;
  longitude: number;
  utc_offset_seconds: number;
  current?: {
    time: string;
    temperature_2m: number;
    relative_humidity_2m: number;
    precipitation: number;
    wind_speed_10m: number;
    weather_code: number;
  };
  hourly?: {
    time: string[];
    temperature_2m: number[];
    relative_humidity_2m: number[];
    precipitation_probability: (number | null)[];
    precipitation: (number | null)[];
  };
  daily?: {
    time: string[];
    sunshine_duration: (number | null)[];
    precipitation_probability_max: (number | null)[];
  };
}

export class OpenMeteoProvider implements WeatherProvider {
  readonly name = 'open-meteo';

  /**
   * fetch 的绑定推迟到实际调用时。
   *
   * 早先写成构造函数的默认参数 `= globalThis.fetch`，那个值在 new 的
   * 那一刻就固定了。若此刻 fetch 不可用（某些嵌入环境、测试替身、
   * 或脚本执行顺序问题），fetchImpl 会是 undefined，之后每次调用
   * 都抛 TypeError 并被包装成「无法连接到天气服务」，
   * 而实际一次请求都没发出过 —— 表现为天气永远不可用。
   */
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(fetchImpl?: typeof fetch, baseUrl: string = ENDPOINT) {
    const f = fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
    if (typeof f !== 'function') {
      throw new TypeError('fetch 不可用，无法获取天气');
    }
    this.fetchImpl = f;
    this.baseUrl = baseUrl;
  }

  async fetch(settings: Settings): Promise<WeatherSnapshot> {
    const url = this.buildUrl(settings);
    let res: Response;
    try {
      res = await this.fetchImpl(url);
    } catch (e) {
      // 网络层失败：把原始错误带出去，不吞
      // 完整 URL 与错误留在 serverResponse 里供远程诊断，
      // 但 message 给界面看的是人话——把几百字符的查询串甩给用户没有意义。
      throw new WeatherFetchError(this.name, '无法连接到天气服务', {
        serverResponse: `GET ${url} -> ${e instanceof Error ? e.name + ': ' + e.message : String(e)}`,
      });
    }

    const body = await res.text();

    if (!res.ok) {
      // AGENTS.md：任何非 2xx 必须回显服务端原文，便于远程诊断
      throw new WeatherFetchError(this.name, `天气服务返回错误（${res.status}）`, {
        status: res.status,
        serverResponse: body,
      });
    }

    let json: OpenMeteoResponse;
    try {
      json = JSON.parse(body) as OpenMeteoResponse;
    } catch {
      throw new WeatherFetchError(this.name, '天气服务返回的不是合法 JSON', {
        status: res.status,
        serverResponse: body.slice(0, 500),
      });
    }

    return this.toSnapshot(json, settings);
  }

  async readCache(): Promise<WeatherSnapshot | undefined> {
    return undefined; // 缓存由存储层负责，Provider 不碰 IndexedDB
  }

  async writeCache(): Promise<void> {
    // 同上
  }

  private buildUrl(settings: Settings): string {
    const p = new URLSearchParams({
      latitude: String(settings.latitude),
      longitude: String(settings.longitude),
      current: 'temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,weather_code',
      hourly: 'temperature_2m,relative_humidity_2m,precipitation_probability,precipitation',
      daily: 'sunshine_duration,precipitation_probability_max',
      timezone: settings.timezone,
      forecast_days: '3',
    });
    return `${this.baseUrl}?${p.toString()}`;
  }

  private toSnapshot(json: OpenMeteoResponse, settings: Settings): WeatherSnapshot {
    if (!json.current) {
      throw new WeatherFetchError(this.name, '响应中缺少 current 字段', {
        serverResponse: JSON.stringify(json).slice(0, 500),
      });
    }

    const offsetMs = json.utc_offset_seconds * 1000;
    const now = Date.now();
    const forecast = this.buildForecast(json, now, offsetMs);
    const daily = json.daily;

    // timestamp 必须是「这份天气是什么时候观测的」，不是「我什么时候请求的」。
    // 两者在用户眼里是同一件事，但在缓存、来源标注、依据回溯里必须分开：
    //   fetchedAt  = 抓取时刻，用于判断缓存新鲜度
    //   observedAt = 观测时刻，用于向用户显示「数据来自几点」
    // Open-Meteo 的 current.time 是当地时间且不带时区后缀，按 utc_offset_seconds 还原。
    const parsedObserved = Date.parse(`${json.current.time}${tzSuffixOf(offsetMs)}`);
    const observedMs = Number.isNaN(parsedObserved) ? now : parsedObserved;

    return {
      // 快照的身份是「这份天气数据」，不是「我什么时候抓的」。
      // 早先 id 里带了 now，导致同一次观测的重复抓取产生不同 id，
      // 缓存会堆积重复天气，latestWeatherSnapshot 也失去去重意义。
      id: `om-${observedMs}-${settings.latitude}-${settings.longitude}`,
      city: settings.city,
      latitude: json.latitude,
      longitude: json.longitude,
      timestamp: new Date(observedMs).toISOString(),
      temperature: json.current.temperature_2m,
      humidity: json.current.relative_humidity_2m,
      // 取今天最大降雨概率作为当天的降雨概率
      rainProbability: daily?.precipitation_probability_max?.[0] ?? forecast[0]?.rainProbability ?? 0,
      rainfall: json.current.precipitation,
      // km/h → m/s。引擎阈值 WIND_HIGH = 6 m/s
      windSpeed: json.current.wind_speed_10m * KMH_TO_MS,
      // 秒 → 小时。 sunshine_duration 单位是秒
      sunlight: (daily?.sunshine_duration?.[0] ?? 0) / 3600,
      weatherCondition: WMO[json.current.weather_code] ?? `天气码 ${json.current.weather_code}`,
      forecast,
      provider: this.name,
    };
  }

  /** 只取从当前时刻开始的未来 48 小时 */
  private buildForecast(json: OpenMeteoResponse, now: number, offsetMs: number): ForecastHour[] {
    const h = json.hourly;
    if (!h) return [];
    const tzSuffix = tzSuffixOf(offsetMs);

    const out: ForecastHour[] = [];
    for (let i = 0; i < h.time.length; i += 1) {
      const local = h.time[i];
      if (!local) continue;
      const t = Date.parse(`${local.length === 16 ? `${local}:00` : local}${tzSuffix}`);
      if (Number.isNaN(t)) continue;
      if (t < now) continue;
      if (out.length >= 48) break;
      out.push({
        timestamp: new Date(t).toISOString(),
        temperature: h.temperature_2m[i] ?? 0,
        humidity: h.relative_humidity_2m[i] ?? 0,
        rainProbability: h.precipitation_probability[i] ?? 0,
        precipitation: h.precipitation[i] ?? 0,
      });
    }
    return out;
  }
}

/** 把 utc_offset_seconds 毫秒数转成 ±HH:MM 后缀，不硬编码 +08:00 */
function tzSuffixOf(offsetMs: number): string {
  const sign = offsetMs >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMs);
  const hh = String(Math.floor(abs / 3_600_000)).padStart(2, '0');
  const mm = String(Math.floor((abs % 3_600_000) / 60_000)).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}
