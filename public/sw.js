/* eslint-env serviceworker */
/**
 * Service worker。
 *
 * 策略定义见 src/data/offlinePolicy.ts，那里有完整测试。
 * 本文件是它的运行时副本，tests/offlinePolicy.test.ts 里有一条
 * 「防漂移」测试会直接跑本文件的 decide()，确保两者行为一致。
 *
 * 最重要的一条：天气 API 与一切跨域请求走 network-only，永不缓存。
 * 缓存天气会在断网时拿旧数据算浇水建议，而用户以为那是现在的。
 */

var CACHE_VERSION = 'v1';
var CACHE_NAME = 'plant-manager-' + CACHE_VERSION;

var NEVER_CACHE_HOSTS = ['api.open-meteo.com', 'geocoding-api.open-meteo.com'];
var PRECACHE_PREFIX = '/assets/';

/**
 * 部署基路径。install 时从 sw-config.js 读，读不到就用 '/'。
 *
 * 为什么要这样：同一份 sw.js 要同时能跑在根路径（Cloudflare Pages / Vercel）
 * 和子路径（GitHub Pages 的 /<仓库名>/）下。写死 '/' 的话，
 * 部署到 Pages 时外壳资源全部 404，离线能力静默失效。
 */
var BASE = '/';

function resolveShell(name) {
  if (name === '/') return BASE;
  return BASE.slice(0, -1) + name;
}

function shellList() {
  return ['/', '/manifest.webmanifest', '/icon.svg', '/icon-maskable.svg'].map(resolveShell);
}

var SHELL_ASSETS = shellList();

function loadBase() {
  return fetch('sw-config.js', { cache: 'no-store' })
    .then(function (r) {
      return r.ok ? r.json() : {};
    })
    .catch(function () {
      return {};
    })
    .then(function (cfg) {
      if (cfg && typeof cfg.base === 'string' && cfg.base) {
        BASE = cfg.base.charAt(cfg.base.length - 1) === '/' ? cfg.base : cfg.base + '/';
        SHELL_ASSETS = shellList();
      }
    });
}

var ABSOLUTE = /^https?:/i;

function pathStartsWith(path, prefix) {
  return (path.split('?')[0] || path).indexOf(prefix) === 0;
}

function decide(request) {
  if (request.method !== 'GET') return 'network-only';
  var url = request.url;

  if (!ABSOLUTE.test(url)) {
    if (request.mode === 'navigate') return 'shell-fallback';
    return pathStartsWith(url, PRECACHE_PREFIX) ? 'cache-first' : 'network-first';
  }

  var u;
  try {
    u = new URL(url);
  } catch {
    return 'network-only';
  }
  if (NEVER_CACHE_HOSTS.indexOf(u.host) !== -1) return 'network-only';
  if (self.location && u.origin !== self.location.origin) return 'network-only';
  if (request.mode === 'navigate') return 'shell-fallback';
  return pathStartsWith(u.pathname, PRECACHE_PREFIX) ? 'cache-first' : 'network-first';
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    // 先读部署基路径再缓存，否则子路径部署时外壳资源会全部 404
    loadBase()
      .then(function () {
        return caches.open(CACHE_NAME);
      })
      // 逐个添加而不是 addAll：某一个 404 不该让整个安装失败
      .then(function (cache) {
        return Promise.all(
          SHELL_ASSETS.map(function (u) {
            return cache.add(u).catch(function () {
              return undefined;
            });
          }),
        );
      })
      .then(function () {
        return self.skipWaiting();
      }),
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (k) {
              return k !== CACHE_NAME;
            })
            .map(function (k) {
              return caches.delete(k);
            }),
        );
      })
      .then(function () {
        return self.clients.claim();
      }),
  );
});

self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  var strategy = decide(request);

  // 天气与跨域：直接放行，出错就是出错
  if (strategy === 'network-only') return;

  if (strategy === 'cache-first') {
    event.respondWith(
      caches.match(request).then(function (hit) {
        if (hit) return hit;
        return fetch(request).then(function (res) {
          if (res && res.ok) {
            var copy = res.clone();
            caches.open(CACHE_NAME).then(function (c) {
              c.put(request, copy);
            });
          }
          return res;
        });
      }),
    );
    return;
  }

  if (strategy === 'shell-fallback') {
    event.respondWith(
      fetch(request).catch(function () {
        return caches.match(BASE);
      }),
    );
    return;
  }

  // network-first
  event.respondWith(
    fetch(request)
      .then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function (c) {
            c.put(request, copy);
          });
        }
        return res;
      })
      .catch(function () {
        return caches.match(request);
      }),
  );
});
