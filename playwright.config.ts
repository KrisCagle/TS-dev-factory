import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// The factory runs with simulated agents, 20× faster, on a throwaway database.
const PORT = Number(process.env.E2E_PORT ?? 4399);
const DATA = path.join(os.tmpdir(), `factory-e2e-${process.pid}`, 'db.json');

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // use a locally installed Chromium if you point at one (PW_CHROMIUM=/path/to/chrome)
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: 'node server/dist/index.js',
    url: `http://localhost:${PORT}/api/state`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: String(PORT),
      FACTORY_DATA: DATA,
      FACTORY_MODE: 'mock',
      FACTORY_MOCK_SPEED: '0.05',
      FACTORY_MOCK_SEED: '7',
      FACTORY_MOCK_HAPPY: '1',
    },
  },
});
