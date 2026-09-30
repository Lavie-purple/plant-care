/**
 * Service worker 注册与更新提示。
 *
 * 两个关键决定：
 *   1. **只在生产构建里注册**。开发时注册会缓存旧模块，HMR 直接失效。
 *   2. **更新必须由用户确认**。这个应用的数据全在本地，
 *      一个坏版本可能让用户以为数据丢了。自动刷新太冒险。
 */

export interface UpdateState {
  /** 有新版本在等待激活 */
  hasUpdate: boolean;
  applyUpdate: () => void;
}

type Handler = (state: UpdateState) => void;

/**
 * 注册 service worker。
 * 返回一个取消函数，未注册时返回空函数——调用方无需分支。
 */
export function registerServiceWorker(onUpdate?: Handler): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => {};

  // 开发模式不注册：SW 会缓存住旧模块，热更新就废了
  if (!import.meta.env.PROD) {
    if (onUpdate) onUpdate({ hasUpdate: false, applyUpdate: () => {} });
    return () => {};
  }

  let waitingWorker: ServiceWorker | null = null;

  navigator.serviceWorker
    .register('/sw.js', { scope: '/' })
    .then((reg) => {
      if (reg.waiting && navigator.serviceWorker.controller) {
        waitingWorker = reg.waiting;
        onUpdate?.({ hasUpdate: true, applyUpdate: () => activate(reg) });
        return;
      }
      reg.addEventListener('updatefound', () => {
        const incoming = reg.installing;
        if (!incoming) return;
        incoming.addEventListener('statechange', () => {
          if (incoming.state === 'installed' && navigator.serviceWorker.controller) {
            // 已有 controller 说明这是一次更新而非首次安装
            waitingWorker = incoming;
            onUpdate?.({ hasUpdate: true, applyUpdate: () => activate(reg) });
          }
        });
      });
    })
    .catch((e) => {
      // 注册失败不该让应用不可用，只是没有离线能力
      console.warn('[pwa] service worker 注册失败：', e);
    });

  return () => {};
}

function activate(reg: ServiceWorkerRegistration): void {
  reg.waiting?.postMessage({ type: 'SKIP_WAITING' });
  // 等新 worker 接管后刷新，让页面用上新代码
  navigator.serviceWorker.addEventListener(
    'controllerchange',
    () => {
      window.location.reload();
    },
    { once: true },
  );
}

/**
 * 是否可以安装（浏览器给出了安装提示）。
 * 只在 standalone 模式之外有意义——已装成应用时不该再提示。
 */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: window-controls-overlay)').matches ||
    nav.standalone === true
  );
}
