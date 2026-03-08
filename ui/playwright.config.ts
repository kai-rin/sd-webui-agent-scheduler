import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 180_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: process.env.WEBUI_URL || 'http://127.0.0.1:7860',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'off',
  },
});
