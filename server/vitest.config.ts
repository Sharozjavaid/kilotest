import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    include: ['test/**/*.test.ts'],
    testTimeout: 90_000,
    hookTimeout: 90_000,
    pool: 'forks',
    // The machine is shared; renders and ffmpeg are CPU-heavy.
    poolOptions: { forks: { maxForks: 2, minForks: 1 } },
  },
});
