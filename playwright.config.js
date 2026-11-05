import { defineConfig, devices } from '@playwright/test';

// On Windows the preinstalled Microsoft Edge is used so no browser download is
// needed. Elsewhere, run `npx playwright install chromium` once, or set
// PW_CHANNEL=chrome to use an installed Chrome.
const channel = process.env.PW_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    channel,
    trace: 'off',
  },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], channel, viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
