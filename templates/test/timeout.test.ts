import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { GRAPHIC_THEMES } from '@kilo/edl';
import { afterAll, describe, expect, it } from 'vitest';
import { MediaTimeoutError, isPipelineError } from '../src/errors.js';
import { shutdown, templates } from '../src/index.js';

/** Finding D for the templates: a hung encoder must not block a worker forever. */

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const WORK = path.join(ROOT, '.work', 'test-timeout');
const savedCache = process.env.KILO_TEMPLATES_CACHE_DIR;

afterAll(async () => {
  delete process.env.KILO_FFMPEG;
  delete process.env.KILO_MEDIA_TIMEOUT_SEC;
  if (savedCache === undefined) delete process.env.KILO_TEMPLATES_CACHE_DIR;
  else process.env.KILO_TEMPLATES_CACHE_DIR = savedCache;
  await shutdown();
});

describe('a hanging encoder', () => {
  it('is killed at the time limit with a typed error, and the next render works', async () => {
    await fs.rm(WORK, { recursive: true, force: true });
    await fs.mkdir(WORK, { recursive: true });
    process.env.KILO_TEMPLATES_CACHE_DIR = path.join(WORK, 'cache');
    // An "ffmpeg" that answers -encoders like the real one and otherwise hangs without reading its input.
    const fake = path.join(WORK, 'ffmpeg-hang');
    await fs.writeFile(fake, `#!/bin/sh\nif [ "$2" = "-encoders" ]; then exec ffmpeg "$@"; fi\nexec sleep 1000 kilo-hang-marker\n`, { mode: 0o755 });
    process.env.KILO_FFMPEG = fake;
    process.env.KILO_MEDIA_TIMEOUT_SEC = '4';
    const req = {
      template: 'stat-callout' as const, props: { value: '42', label: 'seconds' }, theme: GRAPHIC_THEMES[0]!,
      durationSec: 1.5, fps: 30, width: 540, height: 960,
    };
    const t0 = Date.now();
    const err = await templates.renderGraphic({ ...req, outPath: path.join(WORK, 'a.mov') }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaTimeoutError);
    expect(isPipelineError(err)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(60_000);
    await new Promise((r) => setTimeout(r, 300));
    const left = spawnSync('pgrep', ['-f', 'kilo-hang-marker']).stdout.toString().trim();
    expect(left).toBe('');

    delete process.env.KILO_FFMPEG;
    delete process.env.KILO_MEDIA_TIMEOUT_SEC;
    const ok = await templates.renderGraphic({ ...req, outPath: path.join(WORK, 'b.mov') });
    expect(ok.hasAlpha).toBe(true);
  }, 240_000);
});
