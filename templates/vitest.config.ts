import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // Renders are CPU-heavy and share one browser; run files one at a time.
    fileParallelism: false,
  },
});
