/**
 * 构建后处理：生成 sw-config.js 与 GitHub Pages 的 SPA 回退文件。
 *
 * 为什么需要：
 *   1. sw-config.js 把部署基路径告诉 service worker，
 *      使同一份 sw.js 能在根路径与子路径下都工作。
 *   2. GitHub Pages 不做 SPA 回退。直接访问 /某个路径 会 404，
 *      需要一份 404.html，内容与 index.html 相同。
 *   3. manifest 里的 start_url 也要跟着 base 走。
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '..', 'dist-web');
// 与 vite.config.ts 用同一套 env 文件，避免两边读到不同的 base
import { loadEnv } from 'vite';
const env = loadEnv(process.env.BUILD_MODE || 'production', process.cwd(), '');
const base = env.BASE_PATH || '/';

// base 必须以 / 开头、以 / 结尾（根路径就是 '/'）
const normalized = ('/' + base.replace(/^\/+|\/+$/g, '') + '/').replace('//', '/');

writeFileSync(resolve(out, 'sw-config.js'), `// 构建时生成，勿手改。base=${normalized}\nself.__PLANT_BASE__=${JSON.stringify(normalized)};\n`);

const index = resolve(out, 'index.html');
if (existsSync(index)) {
  const html = readFileSync(index, 'utf8');

  // start_url / scope 要跟着 base 走，否则装成应用后图标点开会跳到站点根目录
  const manifestPath = resolve(out, 'manifest.webmanifest');
  if (existsSync(manifestPath)) {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    m.start_url = normalized;
    m.scope = normalized;
    m.id = normalized;
    // 图标路径也要带前缀。子路径部署下写 /icon.svg 会 404，
    // 结果是装成应用后没有图标。
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
} else {
  console.error('[postbuild] 找不到 dist-web/index.html，构建可能失败了');
  process.exit(1);
}
