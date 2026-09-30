import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['tests/ui/**/*.test.tsx', 'tests/ui/**/*.test.ts'],
    // Node 核心测试由 node --test 跑，见 package.json 的 verify 脚本
    exclude: ['node_modules/**', 'dist/**'],
  },
});
