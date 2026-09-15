import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// F24 isolated probe stack (temporary): vite 5199, HMR DISABLED (the shared
// 5174 reloads pages under other lanes' HMR churn — F24 needs a frozen page),
// proxying /api + /ws to the shared server on 8720 (never restarted).
// QA artifact of swarm2/F24 — delete when the lane closes.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5199,
    strictPort: true,
    hmr: false,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8906', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8906', ws: true, changeOrigin: true },
    },
  },
});
