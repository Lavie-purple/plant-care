/**
 * 校验 Pages 构建产物。
 *
 * 存在的理由：Pages 部署失败时最常见的症状是「页面打开是白的」，
 * 而这个原因（资源 404、manifest 路径错、SW 缓存路径不匹配）
 * 在本地构建日志里完全看不出来。
 *
 * 所以在上传 artifact 之前逐项检查，把白屏挡在部署之前。
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '..', 'dist-web');
const problems = [];
const notes = [];

function check(ok, msg) {
  if (ok) notes.push('  OK   ' + msg);
  else problems.push('  FAIL ' + msg);
}

// 1 产物齐全
for (const f of ['index.html', 'manifest.webmanifest', 'sw.js', 'sw-config.js', 'icon.svg']) {
  check(existsSync(resolve(out, f)), `产物存在：${f}`);
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}

// 2 读出实际用的 base。
// sw-config.js 首行是注释，不能直接当 JSON 解析。
const cfgSrc = readFileSync(resolve(out, 'sw-config.js'), 'utf8');
const m = cfgSrc.match(/self\.__PLANT_BASE__\s*=\s*("(?:[^"\\]|\\.)*")/);
check(m !== null, 'sw-config.js 里能读出 __PLANT_BASE__');
if (!m) {
  console.error(problems.join('\n'));
  process.exit(1);
}
const base = JSON.parse(m[1]);
console.log('部署基路径：' + base);

// 3 manifest 的 start_url / scope / 图标都要带 base
const manifest = JSON.parse(readFileSync(resolve(out, 'manifest.webmanifest'), 'utf8'));
check(manifest.start_url === base, `manifest.start_url 与 base 一致（${manifest.start_url}）`);
check(manifest.scope === base, `manifest.scope 与 base 一致（${manifest.scope}）`);
for (const icon of manifest.icons ?? []) {
  check(
    icon.src.startsWith(base),
    `图标路径带 base：${icon.src}`,
  );
}

// 4 index.html 引用的资源要带 base
const html = readFileSync(resolve(out, 'index.html'), 'utf8');
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
const external = refs.filter((r) => /^https?:|^data:|^#/.test(r));
const local = refs.filter((r) => !/^https?:|^data:|^#/.test(r));
for (const r of local) {
  const rel = r.replace(/^\.\//, '');
  check(
    r.startsWith(base) || r.startsWith('./'),
    `index.html 资源路径正确：${r}`,
  );
  check(existsSync(resolve(out, rel.replace(base, ''))), `index.html 引用的文件存在：${rel}`);
}

// 5 关键文件实际能取到
for (const f of ['sw.js', 'sw-config.js', 'manifest.webmanifest', 'icon.svg', 'icon-maskable.svg']) {
  check(existsSync(resolve(out, f)), `Pages 能取到 ${base}${f}`);
}

// 6 SPA 回退
if (base !== '/') {
  const fourPath = resolve(out, '404.html');
  if (existsSync(fourPath)) {
    notes.push('  OK   GitHub Pages 的 SPA 回退 404.html 已生成');
    const four = readFileSync(fourPath, 'utf8');
    check(four === html, '404.html 与 index.html 内容一致（Pages 不做 SPA 回退）');
  } else {
    // 不能直接 readFileSync：文件缺失会抛异常中断脚本，
    // 退出码非零但看不出是哪一项坏了，比校验失败更难查。
    problems.push('  FAIL 缺少 404.html：GitHub Pages 访问子路径会直接 404 白屏');
  }
}

// 7 天���接口不能被缓存。这是上一轮定下的硬约束
// 天气 API 永不缓存。这是上一轮定下的硬约束：
// 缓存了会在断网时拿旧天气算浇水建议，而用户以为那是现在的。
const sw = readFileSync(resolve(out, 'sw.js'), 'utf8');
// 逐项精确匹配，不能用 includes。
// 'api.open-meteo.com' 是 'geocoding-api.open-meteo.com' 的子串，
// 用 includes 的话把天气接口从名单里删掉也能蒙混过关。
const hostList = (sw.match(/var NEVER_CACHE_HOSTS = \[([^\]]*)\]/) || [, ''])[1];
const hosts = hostList.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
check(hosts.includes('api.open-meteo.com'), '天气接口在不缓存名单里（精确匹配）');
check(hosts.includes('geocoding-api.open-meteo.com'), '地理编码接口在不缓存名单里（精确匹配）');
check(
  /NEVER_CACHE_HOSTS\.indexOf\(u\.host\)\s*!==\s*-1\)\s*return\s*'network-only'/.test(sw),
  '天气请求被判为 network-only（不缓存）',
);
// 预缓存外壳清单里不能混进天气接口
const shellBlock = sw.slice(sw.indexOf('shellList'), sw.indexOf('function loadBase'));
check(!shellBlock.includes('open-meteo'), '预缓存外壳清单里没有天气接口');
// 任何 cache.put 都必须在 network-only 判定之后
check(
  sw.indexOf("return 'network-only'") < sw.indexOf('c.put(request, copy)'),
  '缓存写入发生在不缓存判定之后',
);

if (problems.length > 0) {
  console.error('\n构建产物校验未通过：\n' + problems.join('\n'));
  process.exit(1);
}

console.log('\n构建产物校验通过：\n' + notes.join('\n'));
