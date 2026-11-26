import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Renders are CPU-heavy and the machine is shared: one file at a time, one test at a time.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 300_000,
    hookTimeout: 600_000,
  },
});
