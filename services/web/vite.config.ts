/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// BO portal: served by nginx at "/" (see deploy/nginx.conf); in dev "/api" is proxied to the API.
export default defineConfig({
  base: '/',
  plugins: [react()],
    envDir: '../..',
    worker: { format: 'es' },
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
});
