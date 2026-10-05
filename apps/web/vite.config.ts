/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// VITE_TARGET=desktop -> relative asset base ("./") so Tauri (tauri://localhost) and file-like hosts work.
// Default (web) -> "/" for nginx. The router also switches to HashRouter on desktop.
export default defineConfig(() => {
  const desktop = process.env.VITE_TARGET === 'desktop';
  return {
    base: desktop ? './' : '/',
    plugins: [react()],
    server: {
      port: 5173,
      proxy: { '/api': { target: process.env.VITE_DEV_API ?? 'http://localhost:8080', changeOrigin: false } },
    },
    build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 900 },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.ts'],
      css: false,
      include: ['src/**/*.test.{ts,tsx}'],
    },
  };
});
