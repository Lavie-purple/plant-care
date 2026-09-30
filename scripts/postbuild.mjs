/**
 * 构建后处理：生成 sw-config.js、404.html、_redirects，并修正 manifest。
 *
 * 为什么需要：
 *   1. sw-config.js 把部署基路径告诉 service worker，
 *      使同一份 sw.js 能在根路径与子路径下都工作。
 *   2. GitHub Pages 不做 SPA 回退。直接访问 /某个路径 会 404，
 *      需要一份 404.html，内容与 index.html 相同。
 *   3. manifest 的 start_url / scope / 图标路径都要跟着 base 走。
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '..', 'dist-web');

const htmlPath = resolve(out, 'index.html');
if (!existsSync(htmlPath)) {
  console.error('[postbuild] 找不到 dist-web/index.html，构建可能失败了');
  process.exit(1);
}
const html = readFileSync(htmlPath, 'utf8');

/**
 * base 只有一个来源：vite 实际用的那个。
 *
 * 早期实现是「环境变量 > .env 文件」，但 vite build 与 postbuild 是两个独立进程，
 * 要读到同一个 env 文件就必须两边 mode 一致。mode 不一致时读到不同的文件，
 * base 就分歧，SW 缓存路径与资源路径错开，离线能力静默失效（不报错，只是不离线）。
 *
 * 现在改成从 index.html 里的资源路径反推：vite 已经把 base 应用到那里了。
 * 单一来源，不存在「两边猜得不一样」的可能。
 */
const assetMatch = html.match(/(?:src|href)="(\/[^"]*)?\/assets\//);
const normalized = (assetMatch?.[1] ?? '') + '/';
if (!normalized.startsWith('/') || !normalized.endsWith('/')) {
  console.error('[postbuild] 无法从 index.html 推断 base：' + normalized);
  process.exit(1);
}

// 缓存版本由 index.html 的内容哈希生成。
// 早期把版本写死成 v1，结果改代码后版本没变，浏览器认为 SW 没更新，
// 旧缓存也不失效 —— 用户会一直跑上一个构建的代码。
// 实测发现缓存里躺���的 JS 指纹与当前构建对不上。
// 内容变，版本就变，缓存必然失效。这是唯一可靠的依据。
const version = crypto.createHash('sha256').update(html).digest('hex').slice(0, 12);

writeFileSync(
  resolve(out, 'sw-config.js'),
  [
    '// 构建时生成，勿手改。',
    `base=${normalized}`,
    `version=${version}`,
    `self.__PLANT_BASE__=${JSON.stringify(normalized)};`,
    `self.__PLANT_VERSION__=${JSON.stringify(version)};`,
    '',
  ].join('\n'),
);

// manifest：start_url / scope / 图标都要带 base。
// 子路径部署下写 /icon.svg 会 404，结果是装成应用后没有图标。
const manifestPath = resolve(out, 'manifest.webmanifest');
if (existsSync(manifestPath)) {
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  m.start_url = normalized;
  m.scope = normalized;
  m.id = normalized;
  for (const icon of m.icons ?? []) {
    if (icon.src && icon.src.startsWith('/')) icon.src = normalized + icon.src.slice(1);
  }
  writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n');
}

// GitHub Pages 的 SPA 回退：内容与 index 相同
if (normalized !== '/') writeFileSync(resolve(out, '404.html'), html);
// Cloudflare Pages / Vercel 用 _redirects（仅 CF 认，但无害）
writeFileSync(resolve(out, '_redirects'), `/*  ${normalized}  200\n`);

console.log(`[postbuild] base=${normalized}`);
console.log(`[postbuild] 已生成 sw-config.js${normalized !== '/' ? '、404.html' : ''}、_redirects`);
