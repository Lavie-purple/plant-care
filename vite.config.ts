import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolveBase } from './scripts/base-path.mjs';

/**
 * 部署基路径。
 *
 * GitHub Pages 的项目站点跑在 /<仓库名>/ 下，资源路径要带这个前缀；
 * Cloudflare Pages 与 Vercel 跑在根路径。硬代码 '/' 的话，
 * 部署到 Pages 会整页白屏，离线能力也静默失效。
 *
 * 读取顺序：环境变量 > env 文件 > 根路径。
 * 归一化逻辑与 postbuild.mjs 共用 scripts/base-path.mjs，
 * 两边算出不同的 base 会让 SW 缓存路径与资源路径错开。
 */
export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, process.cwd(), '');
  const base = resolveBase(process.env.BASE_PATH || fileEnv.BASE_PATH);

  return {
    base,
    plugins: [react()],
    server: { port: 5173, open: true },
    build: { outDir: 'dist-web', sourcemap: true },
  };
});
