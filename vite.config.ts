import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 部署基路径。
 *
 * GitHub Pages 的项目站点跑在 /<仓库名>/ 下，资源路径要带这个前缀；
 * Cloudflare Pages 与 Vercel 跑在根路径。硬编码 '/' 的话，
 * 部署到 Pages 会整页白屏，离线能力也静默失效。
 *
 * 用 loadEnv 而不是 process.env：config() 的回调里拿不到
 * 命令行传进来的变量，process.env 在 ESM 下也不可靠。
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const raw = env.BASE_PATH || '/';
  const trimmed = raw.replace(/^\/+|\/+$/g, '');
  const base = trimmed ? '/' + trimmed + '/' : '/';

  return {
    base,
    plugins: [react()],
    server: { port: 5173, open: true },
    build: { outDir: 'dist-web', sourcemap: true },
  };
});
