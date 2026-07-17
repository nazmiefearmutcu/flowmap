import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// FlowMap client dev server. Port 5173 matches the server's CORS allow-list
// (spec §11). /api and /ws are proxied to the real flowmap-server on 8720 so
// the client talks to the live server in dev without CORS friction.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8720',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:8720',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
