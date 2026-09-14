import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Development runs against the gateway on 18789 (or QA_CORE_GATEWAY_PORT);
// the built app is served by the gateway itself, so paths are relative.
const gateway = `http://127.0.0.1:${process.env.QA_CORE_GATEWAY_PORT ?? 18789}`;

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: {
    port: 5173,
    proxy: {
      '/api': gateway,
      '/ws': { target: gateway.replace('http', 'ws'), ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
