import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { edlStats, validateEdl } from '@kilo/edl';
import { parseArgs, runEdit } from '../src/cli/kilo.js';
import { ffprobe } from '../src/media.js';
import { createFakePipeline } from '../src/pipeline/fake.js';
import { SERVER_DIR, fixturePath, manifest } from './helpers.js';

describe('kilo edit (fake pipeline)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(SERVER_DIR, '.work', 'cli-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('parses its arguments', () => {
    const args = parseArgs(['edit', 'a.mp4', 'b.mp4', '--out', 'o.mp4', '--mode', 'ugc_ad', '--captions', '--broll', 'x.jpg', 'y.mp4', '--variants', '3', '--quality', 'preview']);
    expect(args).toMatchObject({ clips: ['a.mp4', 'b.mp4'], broll: ['x.jpg', 'y.mp4'], out: 'o.mp4', mode: 'ugc_ad', captions: true, variants: 3, quality: 'preview' });
    expect(() => parseArgs(['edit', 'a.mp4'])).toThrow(/--out/);
    expect(() => parseArgs(['cut', 'a.mp4'])).toThrow(/usage/);
    expect(() => parseArgs(['edit', 'a.mp4', '--out', 'o', '--mode', 'vlog'])).toThrow(/--mode/);
    expect(() => parseArgs(['edit', 'a.mp4', '--out', 'o', '--variants', '9'])).toThrow(/--variants/);
  });

  it('runs ingest, transcribe, decide and render with no database and prints a summary', async () => {
    const m = manifest('unboxing');
    const lines: string[] = [];
    const out = join(dir, 'unboxing.mp4');
    const result = await runEdit(
      {
        ...parseArgs(['edit', ...m.clips.map((c) => fixturePath('unboxing', c.file)), '--out', out, '--mode', 'ugc_ad', '--variants', '2', '--quality', 'preview']),
        broll: m.broll.map((b) => fixturePath('unboxing', b.file)),
        workDir: join(dir, 'work'),
      },
      createFakePipeline(),
      (l) => lines.push(l),
    );
    expect(validateEdl(result.edl, undefined)).toEqual([]);
    expect(result.outputs.map((o) => o.variantId)).toEqual(['hook-a', 'hook-b']);
    for (const o of result.outputs) expect((await ffprobe(o.path)).hasVideo).toBe(true);
    const text = lines.join('\n');
    expect(text).toMatch(/Before: 0:27\.\d across 6 clips/);
    expect(text).toMatch(/After: {2}0:\d\d\.\d \(hook-a\)/);
    expect(text).toContain('retake');
    // The superseded take of line 3 is cut.
    const take1 = result.edl.segments.filter((s) => s.clipId === 'clip3');
    expect(take1.filter((s) => s.keep)).toEqual([]);
    expect(edlStats(result.edl).keptSec).toBeLessThan(edlStats(result.edl).totalSec);
  });
});
