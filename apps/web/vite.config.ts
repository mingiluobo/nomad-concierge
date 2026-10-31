import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@nomad/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)) } },
  server: {
    port: Number(process.env.VITE_PORT ?? 5173),
    proxy: {
      '/api': { target: process.env.API_URL ?? 'http://localhost:3001', changeOrigin: false },
      '/ws': { target: process.env.API_URL ?? 'http://localhost:3001', changeOrigin: false, ws: true },
    },
  },
});
