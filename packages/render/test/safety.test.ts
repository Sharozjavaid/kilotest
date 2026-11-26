import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { CAPTION_HIGHLIGHT, type Edl, type RenderInput, type Transcript } from '@kilo/edl';
import { standInRenderGraphic, type FixtureInputs } from '../src/dev/fixtures.js';
import { buildAss, groupCues, mapWords } from '../src/captions.js';
import { MediaTimeoutError, UnsupportedMediaError, isPipelineError } from '../src/errors.js';
import { runFfmpeg } from '../src/ffmpeg.js';
import { videoChunkArgs, encoderArgs } from '../src/graph.js';
import { buildPlan } from '../src/plan.js';
import { renderVideo } from '../src/render.js';
import { inputArgs } from '../src/safety.js';
import { baseEdl, loadFixture, seg, WORK } from './helpers.js';

/** Findings A and D for the renderer: what it opens, what user text can do, and runaway children. */

const ROOT = join(import.meta.dirname, '..');
const DIR = join(WORK, 'safety');
const SECRET = join(DIR, 'other-user', 'secret.ts');
const HAVE_STRACE = spawnSync('strace', ['-V']).status === 0;
let routine: FixtureInputs;

const HOSTILE = [
  '{\\fs200\\c&H0000FF&}BIG',
  '%{pts\\:hms}',
  "\"double\" 'single'",
  'new\nline\r\nDialogue: 0,0:00:00.00,0:00:09.00,Clean,,0,0,0,,INJECTED',
  'semi;colon,[0:v][out];',
  '\\N\\h\\n',
  '}{',
];

beforeAll(async () => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(DIR, 'other-user'), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-t', '2', '-i', 'testsrc2=s=320x240:r=30', '-c:v', 'libx264', '-preset', 'ultrafast', '-f', 'mpegts', SECRET]);
  routine = await loadFixture('routine');
});

function hostileTranscript(clipId: string): Transcript {
  return {
    clipId,
    language: 'en',
    durationSec: 30,
    words: HOSTILE.map((text, i) => ({ text, start: 4.3 + i * 0.4, end: 4.6 + i * 0.4, filler: false })),
  };
}

describe('user text in captions', () => {
  for (const style of ['clean', 'bold', 'karaoke'] as const) {
    it(`cannot add ASS events, override tags or line breaks (${style})`, () => {
      const edl = baseEdl([seg('a', 'clip1', 4.157, 7.216)], 30);
      const plan = buildPlan({ edl, quality: 'final', clips: routine.clips, broll: {} });
      const cues = groupCues(mapWords(plan.items, [hostileTranscript('clip1')], 30), style, plan.items);
      const ass = buildAss(cues, { style, width: 1080, height: 1920, highlight: CAPTION_HIGHLIGHT, lowerGraphics: [], upperGraphics: [] }, 0, 3.059);
      const events = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
      expect(events.length).toBeGreaterThan(0);
      // Only our own events: one per cue (one per word for karaoke).
      expect(events.length).toBe(style === 'karaoke' ? cues.reduce((n, c) => n + c.words.length, 0) : cues.length);
      expect(ass).not.toContain('INJECTED,'); // the text survives only as words, never as a new event's fields
      for (const e of events) {
        const text = e.split(',').slice(9).join(',');
        // Every override block is one we write: blur, colour, position.
        for (const block of text.match(/\{[^}]*\}/g) ?? []) expect(block).toMatch(/^\{(\\blur\d+|\\1c&H[0-9A-F]{8}|\\an2\\pos\(\d+,\d+\))+\}$/);
        expect(text.replace(/\{[^}]*\}/g, '')).not.toMatch(/[{}]/);
        expect(text).not.toMatch(/\\fs|\\c&|\\h|\\n/);
        expect(e).not.toMatch(/[\r\n]/);
      }
      // The words are still there, as plain text.
      expect(ass).toMatch(/BIG/i);
    });
  }

  it('keeps user text out of the filter graph and the command line', () => {
    const edl = baseEdl([seg('a', 'clip1', 4.157, 7.216)], 30, { captions: { enabled: true, style: 'bold' } });
    const plan = buildPlan({ edl, quality: 'preview', clips: routine.clips, broll: {} });
    const args = videoChunkArgs({
      fmt: plan.format, chunk: plan.chunks[0]!, assFile: 'captions_0.ass', encoder: encoderArgs(plan.format), outFile: 'x.mp4',
      input: (p) => ['-i', `file:${p}`],
    });
    const all = args.join(' ');
    for (const h of ['INJECTED', 'fs200', 'pts\\:hms', 'semi;colon']) expect(all).not.toContain(h);
  });

  it('renders hostile captions end to end', async () => {
    const edl = baseEdl([seg('a', 'clip1', 4.157, 7.216)], 30, { captions: { enabled: true, style: 'clean' } });
    const job = join(DIR, 'job');
    const res = await renderVideo(
      { edl, quality: 'preview', clips: routine.clips, broll: {}, transcripts: [hostileTranscript('clip1')], outPath: join(DIR, 'hostile.mp4'), workDir: job, renderGraphic: standInRenderGraphic },
      { keepIntermediates: true },
    );
    expect(res.durationSec).toBeGreaterThan(3);
    const tmp = readdirSync(job).find((d) => d.startsWith('kilo-render-'))!;
    const ass = readFileSync(join(job, tmp, 'captions_0.ass'), 'utf8');
    expect(ass.split('\n').filter((l) => l.startsWith('Dialogue:')).every((l) => !/\\fs|INJECTED,/.test(l))).toBe(true);
  });
});

describe('inputs are opened by content', () => {
  const hls = () => {
    const p = join(DIR, 'clip.mp4');
    writeFileSync(p, `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n${SECRET}\n#EXT-X-ENDLIST\n`);
    return p;
  };
  const renderWith = (patch: Partial<RenderInput>) => {
    const edl: Edl = baseEdl([seg('a', 'clip1', 4.157, 7.216)], 30);
    return renderVideo({
      edl, quality: 'preview', clips: routine.clips, broll: {}, transcripts: [], outPath: join(DIR, 'out.mp4'), workDir: join(DIR, 'jobs'),
      renderGraphic: standInRenderGraphic, ...patch,
    });
  };

  it('refuses a clip whose file is a playlist, before running ffmpeg', async () => {
    const clips = { clip1: { ...routine.clips.clip1!, path: hls() } };
    const err = await renderWith({ clips }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedMediaError);
    expect(isPipelineError(err)).toBe(true);
  });

  it('refuses a graphic file that is not a real movie', async () => {
    const edl = baseEdl([seg('a', 'clip1', 4.157, 7.216)], 30, {
      overlays: [{ id: 'g', type: 'graphic', anchorSegmentId: 'a', offsetSec: 0.5, durationSec: 1.5, template: 'stat-callout', props: { value: '1', label: 'x' } }],
    });
    const err = await renderWith({
      edl,
      renderGraphic: async (req) => {
        writeFileSync(req.outPath, `ffconcat version 1.0\nfile '${SECRET}'\n`);
        return { path: req.outPath, hasAlpha: true };
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedMediaError);
  });

  it.skipIf(!HAVE_STRACE)('the forced demuxer never follows a playlist, even if handed one', () => {
    const log = join(DIR, 'strace.log');
    const r = spawnSync('strace', ['-f', '-qq', '-e', 'trace=openat', '-o', log, 'ffmpeg', '-v', 'error', ...inputArgs({ path: hls(), container: 'mov' }), '-f', 'null', '-']);
    expect(r.status).not.toBe(0);
    expect(readFileSync(log, 'utf8')).not.toContain('secret');
  });
});

describe('runaway ffmpeg', () => {
  it('a render step that hangs is killed with a typed error', async () => {
    const err = await runFfmpeg(['-f', 'lavfi', '-i', 'nullsrc=s=16x16', '-f', 'null', '-'], { timeoutMs: 1500 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaTimeoutError);
    expect(spawnSync('pgrep', ['-f', 'nullsrc=s=16x16 -f null']).stdout.toString().trim()).toBe('');
  });

  it('SIGTERM of the parent kills a running render ffmpeg', async () => {
    const marker = `kilo-render-hang-${process.pid}`;
    const child = spawn(process.execPath, ['--import', 'tsx', '-e', `
      const { runFfmpeg } = await import('./src/ffmpeg.ts');
      runFfmpeg(['-f', 'lavfi', '-i', 'nullsrc=s=16x16', '-metadata', 'title=${marker}', '-f', 'null', '-'], { timeoutMs: 600000 }).catch(() => {});
      setTimeout(() => console.log('ready'), 500);
      setInterval(() => {}, 1000);
    `], { cwd: ROOT });
    await new Promise<void>((r) => child.stdout.on('data', (d: Buffer) => d.toString().includes('ready') && r()));
    const pg = () => spawnSync('pgrep', ['-f', `title=${marker}`]).stdout.toString().trim().split('\n').filter(Boolean)
      .filter((pid) => Number(pid) !== child.pid)
      .filter((pid) => { try { return !/^\d+ \(.*\) [ZX] /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; } });
    expect(pg().length).toBe(1);
    const exited = new Promise<string | null>((r) => child.on('exit', (_c, s) => r(s)));
    child.kill('SIGTERM');
    expect(await exited).toBe('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    expect(pg()).toEqual([]);
  });
});
