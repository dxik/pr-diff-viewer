import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['test/setup.ts'],
    include: ['test/{server,frontend}/**/*.spec.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['server/**/*.ts', 'src/**/*.{ts,tsx}'],
      exclude: ['server/index.ts', 'src/main.tsx'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
