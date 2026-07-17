import { defineConfig, devices } from '@playwright/test';

// E2E config. The webServer boots the vite dev server (which proxies to the
// real flowmap-server on 8720). Later tasks add specs under tests/e2e.
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
  webServer: {
    // Pin to IPv4 — vite otherwise binds [::1] only, which the 127.0.0.1
    // baseURL/url below cannot reach (webServer readiness would time out).
    command: 'npm run dev -- --host 127.0.0.1',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
