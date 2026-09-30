import { useEffect, useState } from 'react';
import { registerServiceWorker, type UpdateState } from './pwa.js';

/**
 * 有新版本时的提示条。
 *
 * 不自动刷新。这个应用的数据全在本地，用户看到页面突然变了
 * 第一反应是「我的数据是不是没了」。必须让他自己点。
 */
export function UpdateBar() {
  const [state, setState] = useState<UpdateState>({ hasUpdate: false, applyUpdate: () => {} });

  useEffect(() => registerServiceWorker(setState), []);

  if (!state.hasUpdate) return null;

  return (
    <div className="ub" role="status">
      <div style={{ flex: 1 }}>
        <div className="t-label" style={{ fontWeight: 600 }}>有新版本</div>
        <div className="t-meta" style={{ marginTop: 2 }}>
          你的数据都在本地，刷新不会丢
        </div>
      </div>
      <button className="btn" type="button" onClick={() => state.applyUpdate()}>
        稍后
      </button>
      <button className="btn btn-primary" type="button" onClick={() => state.applyUpdate()}>
        立即刷新
      </button>

      <style>{`
        .ub {
          position: fixed; left: 50%; transform: translateX(-50%);
          bottom: calc(var(--nav-h) + 12px); z-index: var(--z-modal);
          width: min(520px, calc(100vw - 24px));
          display: flex; align-items: center; gap: var(--sp-2);
          padding: var(--sp-3) var(--sp-4);
          background: var(--sf); border: 1px solid var(--ln2);
          border-radius: var(--r-ctl); box-shadow: var(--shadow-pop);
        }
      `}</style>
    </div>
  );
}
