import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // each test file builds its own factory on a temp database, so files can run in parallel
    pool: 'forks',
  },
});
