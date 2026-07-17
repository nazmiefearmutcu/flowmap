import { fileURLToPath } from 'node:url';

import { defineConfig, devices } from '@playwright/test';

// Absolute path to the Python server package (sibling of client/), resolved
// through the flowmap symlink so `uv run` finds the project regardless of cwd.
const SERVER_DIR = fileURLToPath(new URL('../server', import.meta.url));

// E2E config. Two webServers boot together: the real flowmap-server (Python, on
// 8720 — the port vite proxies to) and the vite dev server. The live-sim spec
// (T5) drives the sim feed end-to-end through this stack; heatmap.spec (T4) uses
// the synthetic window.__flowmapTest hook and needs only vite.
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // WebGL2 must actually render in headless CI. Force ANGLE→SwiftShader
        // (software GL) so the heatmap renders even without a real GPU; the
        // unsafe-swiftshader flag opts into SwiftShader WebGL on recent Chromium.
        launchOptions: {
          args: [
            '--use-gl=angle',
            '--use-angle=swiftshader',
            '--enable-unsafe-swiftshader',
            '--ignore-gpu-blocklist',
          ],
        },
      },
    },
  ],
  webServer: [
    {
      // Real flowmap-server with the REALTIME sim feed (4 finalized cols/s).
      // Recording disabled so the e2e never touches disk or rehydrates a stale
      // tail. reuseExistingServer lets a manually-booted 8720 serve locally.
      command: 'uv run python -m flowmap_server',
      cwd: SERVER_DIR,
      env: {
        FLOWMAP_PORT: '8720',
        FLOWMAP_RECORDING_ENABLED: '0',
        FLOWMAP_LOG_LEVEL: 'warning',
      },
      url: 'http://127.0.0.1:8720/api/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // Pin to IPv4 — vite otherwise binds [::1] only, which the 127.0.0.1
      // baseURL/url below cannot reach (webServer readiness would time out).
      command: 'npm run dev -- --host 127.0.0.1',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
