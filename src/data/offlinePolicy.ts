/**
 * 离线策略（纯逻辑，被 service worker 与测试共用）。
 *
 * 最要紧的一条：**天气 API 永不缓存**。
 * 缓存了就会在断网时拿一份几小时前的天气去算浇水建议，
 * 而用户以为那是现在的天气。这比「天气不可用」糟糕得多——
 * 后者会明确降级，前者会安静地给出错误建议。
 *
 * 同样重要的是：**跨域一律不碰**。第三方资源不该进本应用的缓存，
 * 否则失效顺序会变得无法预测。
 */

export type Strategy =
  /** 只走网络。失败就是失败，由页面降级 */
  | 'network-only'
  /** 缓存优先。内容哈希过的静态资源 */
  | 'cache-first'
  /** 网络优先，失败回落缓存 */
  | 'network-first'
  /** 导航请求：网络优先，失败回落到应用外壳 */
  | 'shell-fallback';

/** 走网络、绝不入缓存的外部主机。命中即 network-only。 */
export const NEVER_CACHE_HOSTS = ['api.open-meteo.com', 'geocoding-api.open-meteo.com'];

/** Vite 构建产物的目录。里面都是内容哈希过的文件，可以永久缓存。 */
export const PRECACHE_PREFIX = '/assets/';

export interface RouteInput {
  method: string;
  /**
   * 请求 URL。相对路径与绝对路径都接受——
   * service worker 拿到的是绝对路径，页面内与测试里常用相对路径。
   */
  url: string;
  /** 是否是页面导航 */
  isNavigation: boolean;
  /**
   * 应用自身的来源。service worker 传 self.location.origin。
   * 不传时不做跨域判定（相对路径场景本来也没有跨域可言）。
   */
  selfOrigin?: string;
}

const ABSOLUTE = /^https?:/i;

export function decideStrategy(input: RouteInput): Strategy {
  const { method, isNavigation, selfOrigin, url } = input;

  // 只处理 GET。POST 等请求交给浏览器默认行为，SW 不插手。
  if (method !== 'GET') return 'network-only';

  // 相对路径：必定同源，只看路径
  if (!ABSOLUTE.test(url)) {
    if (isNavigation) return 'shell-fallback';
    return pathStartsWith(url, PRECACHE_PREFIX) ? 'cache-first' : 'network-first';
  }

  // 绝对路径：解析失败一律不碰
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'network-only';
  }

  if (NEVER_CACHE_HOSTS.includes(u.host)) return 'network-only';
  if (selfOrigin !== undefined && u.origin !== selfOrigin) return 'network-only';

  if (isNavigation) return 'shell-fallback';
  return pathStartsWith(u.pathname, PRECACHE_PREFIX) ? 'cache-first' : 'network-first';
}

function pathStartsWith(path: string, prefix: string): boolean {
  const clean = path.split('?')[0] ?? path;
  return clean.startsWith(prefix);
}

/**
 * 应用外壳清单。
 *
 * 只有外壳进预缓存。天气、IndexedDB 里的数据都不在这里——
 * 数据本来就在本地，缓存它只会制造第二份真相。
 */
export const SHELL_ASSETS = ['/', '/manifest.webmanifest', '/icon.svg', '/icon-maskable.svg'];

/** 缓存版本。改动缓存策略或外壳时必须 +1，否则旧缓存不会失效。 */
export const CACHE_VERSION = 'v1';
export const CACHE_NAME = `plant-manager-${CACHE_VERSION}`;
