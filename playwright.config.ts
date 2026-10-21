import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  use: { baseURL: 'http://127.0.0.1:4317' },
  webServer: {
    command: 'pnpm dev:web',
    url: 'http://127.0.0.1:4317',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
