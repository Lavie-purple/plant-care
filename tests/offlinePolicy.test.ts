/**
 * 离线策略测试。
 *
 * 最关键的一条：天气 API 绝不能被缓存。
 * 缓存了会在断网时拿旧天气算浇水建议，而且用户以为那是现在的——
 * 这比明确显示「天气不可用」危险得多。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  CACHE_NAME,
  CACHE_VERSION,
  NEVER_CACHE_HOSTS,
  PRECACHE_PREFIX,
  SHELL_ASSETS,
  decideStrategy,
} from '../src/data/offlinePolicy.js';
import { readFileSync } from 'node:fs';

const nav = (url: string) => ({ method: 'GET', url, isNavigation: true });
const asset = (url: string) => ({ method: 'GET', url, isNavigation: false });

describe('天气 API 永不缓存（最要紧的一条）', () => {
  test('天气接口走 network-only', () => {
    const r = decideStrategy(asset('https://api.open-meteo.com/v1/forecast?latitude=23.1&longitude=113.2'));
    assert.equal(r, 'network-only');
  });

  test('地理编码接口同样不缓存', () => {
    const r = decideStrategy(asset('https://geocoding-api.open-meteo.com/v1/search?name=广州'));
    assert.equal(r, 'network-only');
  });

  test('即使天气接口返回的是 POST 也一样不缓存', () => {
    const r = decideStrategy({ method: 'POST', url: 'https://api.open-meteo.com/v1/forecast', isNavigation: false });
    assert.equal(r, 'network-only');
  });

  test('跨域第三方一律不碰，避免污染缓存', () => {
    const r = decideStrategy({
      ...asset('https://cdn.example.com/whatever.js'),
      selfOrigin: 'http://localhost:5173',
    });
    assert.equal(r, 'network-only');
  });

  test('被列入黑名单的主机清单覆盖天气与地理编码两个接口', () => {
    assert.ok(NEVER_CACHE_HOSTS.includes('api.open-meteo.com'), '必须覆盖天气接口');
    assert.ok(NEVER_CACHE_HOSTS.includes('geocoding-api.open-meteo.com'), '必须覆盖地理编码接口');
  });
});

describe('静态资源按内容哈希永久缓存', () => {
  test('Vite 构建产物走 cache-first', () => {
    const r = decideStrategy(asset('http://localhost:5173/assets/index-a1b2c3d4.js'));
    assert.equal(r, 'cache-first');
  });

  test('CSS 同样缓存', () => {
    assert.equal(decideStrategy(asset('/assets/index-a1b2c3d4.css')), 'cache-first');
  });

  test('非哈希资源不进永久缓存', () => {
    assert.equal(decideStrategy(asset('/icon.svg')), 'network-first');
  });
});

describe('页面导航回落应用外壳', () => {
  test('导航走 shell-fallback', () => {
    assert.equal(decideStrategy(nav('http://localhost:5173/')), 'shell-fallback');
    assert.equal(decideStrategy(nav('http://localhost:5173/anything')), 'shell-fallback');
  });

  test('天气 URL 即使伪装成导航也不缓存', () => {
    const r = decideStrategy(nav('https://api.open-meteo.com/v1/forecast'));
    assert.equal(r, 'network-only');
  });
});

describe('非 GET 请求不插手', () => {
  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    test(`${m} 交给浏览器默认行为`, () => {
      assert.equal(decideStrategy({ method: m, url: 'http://localhost:5173/', isNavigation: false }), 'network-only');
    });
  }
});

describe('非法 URL 不炸', () => {
  test('无法解析的 URL 走 network-only', () => {
    // 相对路径按同源处理，不是解析失败
    assert.equal(decideStrategy(asset('不是 URL')), 'network-first');
    assert.equal(decideStrategy(asset('http://[')), 'network-only');
  });
});

describe('缓存清单', () => {
  test('外壳清单不含任何动态数据', () => {
    for (const a of SHELL_ASSETS) {
      assert.ok(!a.includes('open-meteo'), '天气接口不得进预缓存');
    }
  });

  test('外壳包含根路径与图标', () => {
    assert.ok(SHELL_ASSETS.includes('/'));
    assert.ok(SHELL_ASSETS.some((a) => a.includes('icon')));
    assert.ok(SHELL_ASSETS.some((a) => a.includes('manifest')));
  });

  test('缓存名带版本号，改策略后能失效旧缓存', () => {
    assert.ok(CACHE_NAME.includes(CACHE_VERSION));
    assert.match(CACHE_VERSION, /^v\d+$/);
  });
});

/**
 * 防漂移：public/sw.js 与 offlinePolicy.ts 是两份实现。
 * 这里直接读 sw.js 源码，验证它包含同样的黑名单与前缀，
 * 避免「改了策略忘了同步到 service worker」这种静默失效。
 */
describe('service worker 与策略模块保持一致', () => {
  const src = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

  test('黑名单主机一致', () => {
    for (const h of NEVER_CACHE_HOSTS) {
      assert.ok(src.includes(h), `sw.js 缺少黑名单主机 ${h}`);
    }
  });

  test('预缓存前缀一致', () => {
    assert.ok(src.includes(PRECACHE_PREFIX), 'sw.js 的预缓存前缀与策略模块不一致');
  });

  test('缓存版本一致', () => {
    assert.ok(src.includes(CACHE_VERSION), 'sw.js 的缓存版本与策略模块不一致');
  });

  test('天气请求确实走 network-only 而不是被缓存', () => {
    // 直接在 sw.js 源码里跑一次判定
    const sandbox = { self: null, caches: {}, URL, fetch: undefined };
    const fn = new Function('self', 'URL', 'fetch', src.slice(0, src.indexOf('self.addEventListener')) + '\nreturn decide;');
    const decide = fn(sandbox.self, URL, undefined) as typeof decideStrategy;
    const r = decide({
      method: 'GET',
      url: 'https://api.open-meteo.com/v1/forecast?latitude=23.1',
      isNavigation: false,
    });
    assert.equal(r, 'network-only', 'sw.js 实际行为：天气被缓存了');
  });
});
