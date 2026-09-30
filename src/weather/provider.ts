/**
 * 天气数据源抽象层。
 *
 * D-14：业务逻辑不得直接调用 HTTP。所有天气获取都经过 WeatherProvider 接口，
 * 以便未来替换数据源，也以便在离线测试中注入 MockProvider。
 *
 * 硬约束：
 *   1. 任何非 2xx 必须抛出携带服务端原文的错误，便于远程诊断。
 *   2. Provider 失败时返回 WeatherUnavailable，由引擎降级，绝不返回假数据。
 *   3. 断网时使用最后一次缓存并标注时间戳，不得假装是实时数据。
 */

import type { Settings, WeatherInput, WeatherSnapshot } from '../domain/types.js';

export interface WeatherProvider {
  readonly name: string;
  /** 拉取最新天气。失败时抛 WeatherFetchError，不要吞掉。 */
  fetch(settings: Settings): Promise<WeatherSnapshot>;
  /** 读取最后一次成功获取的缓存，没有则返回 undefined */
  readCache(settings: Settings): Promise<WeatherSnapshot | undefined>;
  writeCache(snapshot: WeatherSnapshot): Promise<void>;
}

/**
 * 天气获取失败。message 里必须带服务端返回的原文。
 */
export class WeatherFetchError extends Error {
  readonly provider: string;
  readonly status: number | undefined;
  /** 服务端返回的原始响应体，不截断 */
  readonly serverResponse: string | undefined;

  constructor(provider: string, message: string, opts: { status?: number; serverResponse?: string } = {}) {
    super(message);
    this.name = 'WeatherFetchError';
    this.provider = provider;
    this.status = opts.status;
    this.serverResponse = opts.serverResponse;
  }
}

/** 把 Provider 抛出的错误或缺失缓存统一转成引擎可消费的 WeatherInput */
export function toWeatherInput(
  snapshot: WeatherSnapshot | undefined,
  failure?: { reason: string; lastSuccessAt?: string },
): WeatherInput {
  if (snapshot) return { available: true, snapshot };
  return {
    available: false,
    fallback: {
      unavailable: true,
      reason: failure?.reason ?? '尚未获取过天气数据',
      ...(failure?.lastSuccessAt !== undefined ? { lastSuccessAt: failure.lastSuccessAt } : {}),
    },
  };
}
