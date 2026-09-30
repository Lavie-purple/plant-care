import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, open: true },
  build: { outDir: 'dist-web', sourcemap: true },
  // fake-indexeddb 只在测试里用，生产走浏览器原生 IndexedDB
});
