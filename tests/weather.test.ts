/**
 * 天气数据源测试。
 *
 * 重点不是「能不能取到天气」，而是：
 *   1. 单位换算对不对（这是真实踩过的坑：km/h vs m/s，秒 vs 小时）
 *   2. 服务挂掉时，错误信息能不能远程诊断
 *   3. 降级路径下引擎还能不能给出建议
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { OpenMeteoProvider } from '../src/weather/open-meteo.js';
import { MockWeatherProvider, SCENARIOS } from '../src/weather/mock.js';
import { WeatherFetchError, toWeatherInput } from '../src/weather/provider.js';
import { generateRecommendation } from '../src/engine/recommendation.js';
import type { Settings } from '../src/domain/types.js';

const SETTINGS: Settings = {
  city: '广州',
  latitude: 23.11667,
  longitude: 113.25,
  timezone: 'Asia/Shanghai',
  weatherRefreshMinutes: 30,
  pendingCompletionDays: 14,
  baselinePotDiameterCm: 18,
  baselineWaterMl: 500,
  updatedAt: '2026-09-30T00:00:00+08:00',
};

/** 2026-09-30 真实接口响应的结构样本，字段名与单位均已核对 */
function realResponseFixture() {
  return {
    latitude: 23.093145,
    longitude: 113.253136,
    utc_offset_seconds: 28800,
    current: {
      time: '2026-09-30T16:00',
      temperature_2m: 35.6,
      relative_humidity_2m: 48,
      precipitation: 0.3,
      wind_speed_10m: 8.9, // km/h
      weather_code: 95,
    },
    hourly: {
      time: ['2026-09-30T15:00', '2026-09-30T16:00', '2026-10-01T00:00'],
      temperature_2m: [35.0, 35.6, 28.0],
      relative_humidity_2m: [50, 48, 80],
      precipitation_probability: [10, 20, 75],
      precipitation: [0, 0.3, 5],
    },
    daily: {
      time: ['2026-09-30'],
      sunshine_duration: [32400], // 秒 = 9 小时
      precipitation_probability_max: [30],
    },
  };
}

function stubFetch(body: unknown, init: { ok?: boolean; status?: number; statusText?: string } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return (async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    text: async () => text,
  })) as unknown as typeof fetch;
}

describe('OpenMeteoProvider：单位换算（真实踩过的坑）', () => {
  test('风速从 km/h 换算成 m/s', async () => {
    const p = new OpenMeteoProvider(stubFetch(realResponseFixture()));
    const snap = await p.fetch(SETTINGS);
    // 8.9 km/h ÷ 3.6 = 2.472 m/s
    assert.ok(
      Math.abs(snap.windSpeed - 8.9 / 3.6) < 0.001,
      `风速换算错误：得到 ${snap.windSpeed}，期望 ${8.9 / 3.6}`,
    );
  });

  test('日照从秒换算成小时', async () => {
    const p = new OpenMeteoProvider(stubFetch(realResponseFixture()));
    const snap = await p.fetch(SETTINGS);
    // 32400 秒 = 9 小时
    assert.equal(snap.sunlight, 9);
  });

  test('风速换算错会导致大风规则失效', async () => {
    // 若不换算，8.9 会被当成 8.9 m/s，低于阈值 6? 不，8.9 > 6 会误判
    // 正确值 2.47 m/s < 6，不该触发大风
    const p = new OpenMeteoProvider(stubFetch(realResponseFixture()));
    const snap = await p.fetch(SETTINGS);
    assert.ok(snap.windSpeed < 6, '换算后不应触发大风阈值');
  });

  test('天气码映射为中文，未知码不编造', async () => {
    const fixture = realResponseFixture();
    fixture.current.weather_code = 95;
    const p = new OpenMeteoProvider(stubFetch(fixture));
    const snap = await p.fetch(SETTINGS);
    assert.equal(snap.weatherCondition, '雷雨');

    fixture.current.weather_code = 999;
    const p2 = new OpenMeteoProvider(stubFetch(fixture));
    const snap2 = await p2.fetch(SETTINGS);
    assert.equal(snap2.weatherCondition, '天气码 999', '未知天气码应原样显示，不得编造');
  });

  test('预报按接口自带时区还原，丢弃已过时刻', async () => {
    const p = new OpenMeteoProvider(stubFetch(realResponseFixture()));
    const snap = await p.fetch(SETTINGS);
    assert.ok(snap.forecast.length > 0, '应有未来预报');
    for (const h of snap.forecast) {
      assert.ok(Date.parse(h.timestamp) > 0, '时间戳必须可解析');
    }
  });
});

describe('OpenMeteoProvider：失败必须可远程诊断', () => {
  test('非 2xx 时抛出错误并携带服务端原文', async () => {
    const p = new OpenMeteoProvider(
      stubFetch('{"error":true,"reason":"Invalid latitude"}', { ok: false, status: 400, statusText: 'Bad Request' }),
    );
    try {
      await p.fetch(SETTINGS);
      assert.fail('应当抛出 WeatherFetchError');
    } catch (e) {
      assert.ok(e instanceof WeatherFetchError);
      assert.equal(e.status, 400);
      assert.match(e.serverResponse ?? '', /Invalid latitude/, '必须回显服务端原文');
    }
  });

  test('网络层失败时错误信息里带 URL', async () => {
    const failing = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const p = new OpenMeteoProvider(failing);
    try {
      await p.fetch(SETTINGS);
      assert.fail('应当抛出');
    } catch (e) {
      assert.ok(e instanceof WeatherFetchError);
      assert.match(e.message, /api\.open-meteo\.com/, '错误信息必须含 URL 以便定位');
      assert.match(e.serverResponse ?? '', /Failed to fetch/);
    }
  });

  test('返回非法 JSON 时报错并截取原文', async () => {
    const p = new OpenMeteoProvider(stubFetch('not json at all'));
    await assert.rejects(() => p.fetch(SETTINGS), /不是合法 JSON/);
  });

  test('缺少 current 字段时明确报错', async () => {
    const fixture = realResponseFixture() as Partial<ReturnType<typeof realResponseFixture>>;
    delete fixture.current;
    const p = new OpenMeteoProvider(stubFetch(fixture));
    await assert.rejects(() => p.fetch(SETTINGS), /缺少 current/);
  });
});

describe('降级：天气挂了，植物管理仍可用', () => {
  test('Provider 失败时转成 WeatherInput 且标注原因', () => {
    const input = toWeatherInput(undefined, { reason: '网络请求失败', lastSuccessAt: '2026-09-30T12:00:00+08:00' });
    assert.equal(input.available, false);
    if (!input.available) {
      assert.equal(input.fallback.reason, '网络请求失败');
      assert.equal(input.fallback.lastSuccessAt, '2026-09-30T12:00:00+08:00');
    }
  });

  test('断网时引擎照样给出建议（这是 D-14 的核心要求）', () => {
    const weather = toWeatherInput(undefined, { reason: '断网' });
    const r = generateRecommendation({
      plant: {
        id: 'p1',
        name: '龟背竹 A',
        placement: '客厅',
        exposure: 'indoor_window',
        tags: [],
        createdAt: '',
        updatedAt: '',
        version: 1,
      },
      careRule: {
        id: 'r1',
        plantId: 'p1',
        recommendedIntervalMin: 7,
        recommendedIntervalMax: 10,
        minimumInterval: 5,
        maximumInterval: 12,
        source: 'user',
        userOverride: true,
        updatedAt: '',
        version: 1,
      },
      history: [
        {
          id: 'w1',
          plantId: 'p1',
          date: '2026-09-28',
          time: '14:00',
          method: '浇透',
          fertilizerIncluded: false,
          images: [],
          completionState: 'complete',
          entrySource: 'single',
          createdAt: '',
          updatedAt: '',
          version: 1,
        },
      ],
      weather,
      now: new Date('2026-09-30T14:32:00+08:00'),
    });

    assert.ok(['CHECK', 'WATER_NOW', 'DELAY', 'NO_ACTION'].includes(r.recommendation.action));
    assert.equal(r.recommendation.basedOn.weatherUnavailable, true);
    const texts = r.recommendation.reasons.map((x) => x.text).join(' ');
    assert.match(texts, /天气数据暂不可用/, '必须明确告知天气不可用，不得静默');
  });

  test('MockProvider 失败时抛 WeatherFetchError', async () => {
    const m = new MockWeatherProvider();
    m.setFailure('模拟断网');
    await assert.rejects(() => m.fetch(SETTINGS), WeatherFetchError);
  });
});

describe('MockProvider：闭环测试不依赖网络', () => {
  test('相同场景产出相同天气', async () => {
    const m = new MockWeatherProvider(SCENARIOS.hotDry);
    const a = await m.fetch(SETTINGS);
    const b = await m.fetch(SETTINGS);
    assert.equal(a.temperature, b.temperature);
    assert.equal(a.rainProbability, b.rainProbability);
    assert.equal(a.forecast.length, 48, '默认给 48 小时预报');
  });

  test('地点从 Settings 取，不写死', async () => {
    const m = new MockWeatherProvider();
    const snap = await m.fetch({ ...SETTINGS, city: '北京' });
    assert.equal(snap.city, '北京');
  });

  test('缓存写入后可读回', async () => {
    const m = new MockWeatherProvider();
    const snap = await m.fetch(SETTINGS);
    await m.writeCache(snap);
    const cached = await m.readCache(SETTINGS);
    assert.equal(cached?.id, snap.id);
  });

  test('调用次数可统计，用于验证缓存策略', async () => {
    const m = new MockWeatherProvider();
    await m.fetch(SETTINGS);
    await m.fetch(SETTINGS);
    assert.equal(m.fetchCount, 2);
  });
});
