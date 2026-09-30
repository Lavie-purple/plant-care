import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Repository } from '../storage/repository.js';
import { OpenMeteoProvider } from '../weather/open-meteo.js';
import { PlantCareService, systemClock } from '../app/vertical-slice.js';
import { App } from './App.js';
import './tokens.css';

/**
 * 不再预置示例植物。
 *
 * 早先这里会写死两盆「龟背竹 A」「薄荷」当演示数据。它在开发时掩盖过真实问题，
 * 而且在库还没加载完的瞬间会被误判成「空库」而覆盖用户数据。
 * 示例数据属于测试夹具（见 tests/），不属于生产代码。
 *
 * 启动失败必须显示给人看。早先 open() 失败时这里直接 reject，
 * 页面表现为一片黑屏且没有任何提示，用户无从下手。
 */
const mount = document.getElementById('root');
if (!mount) throw new Error('缺少 #root 挂载点');
const root: HTMLElement = mount;

function fatal(message: string, detail?: unknown): void {
  const el = document.createElement('div');
  el.style.cssText =
    'padding:24px;font-family:system-ui,sans-serif;color:#f2f4ee;background:#141613;min-height:100dvh;';
  const h = document.createElement('div');
  h.style.cssText = 'font-size:16px;font-weight:600;margin-bottom:8px;';
  h.textContent = '应用没能启动';
  const p = document.createElement('div');
  p.style.cssText = 'font-size:13px;line-height:1.7;color:#aeb5a6;';
  p.textContent = message;
  const d = document.createElement('pre');
  d.style.cssText =
    'margin-top:14px;padding:10px;font-size:11px;white-space:pre-wrap;word-break:break-all;' +
    'background:#1c1f1a;border:1px solid #464e40;border-radius:4px;color:#7a8274;';
  d.textContent = detail !== undefined ? String(detail) : '';
  el.append(h, p, d);
  root.replaceChildren(el);
}

const repo = new Repository();
try {
  await repo.open();
} catch (e) {
  fatal(
    '本地数据库打不开。你的数据全部存在这台设备的浏览器里，请检查浏览器的隐私模式或存储权限。',
    e instanceof Error ? e.message : String(e),
  );
  throw e;
}

const service = new PlantCareService(repo, new OpenMeteoProvider(), systemClock());
createRoot(root).render(
  <StrictMode>
    <App service={service} />
  </StrictMode>,
);
