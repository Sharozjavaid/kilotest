import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApiError,
  CreateRenderResponse,
  Edl,
  MODE_PRESETS,
  PACING_PARAMS,
  RenderView,
  SaveEdlResponse,
  VideoDetail,
  VideoSummary,
  getTemplate,
  resolveTimeline,
  toggleSegment,
  validateEdl,
  type AnalyzeApi,
  type EditSettings,
  type Mode,
  type RenderApi,
  type Segment,
  type TemplatesApi,
  type Transcript,
} from '@kilo/edl';
import { loadRealPipeline } from '../src/pipeline/real.js';
import type { Pipeline } from '../src/pipeline/types.js';
import { FIXTURES, SERVER_DIR, createEnv, manifest, newUser, uploadFixtures, type Client, type TestEnv } from './helpers.js';

/**
 * The acceptance run: every fixture through HTTP, the queue and the worker with the
 * real @kilo/analyze, @kilo/render and @kilo/templates. Opt-in (`npm run test:real`,
 * KILO_TEST_REAL=1): it takes several minutes and needs ffmpeg and Chromium.
 *
 * For each fixture: create the batch with the fixture's mode and B-roll, graphics,
 * captions and three hooks on; upload; wait for review; score the EDL against the
 * manifest's ground truth; restore one cut segment and save; replan; render a
 * preview and a final of every variant; download and check them with ffprobe and by
 * looking at every frame for the fixtures' orange "cut" band.
 */

const OUT = join(SERVER_DIR, '.work', 'acceptance');

interface Unit {
  start: number;
  end: number;
  keep: boolean;
  reason: string;
  kind: 'speech' | 'filler' | 'pause';
  text: string;
}
interface FixtureClip {
  name: string;
  file: string;
  wordsFile: string;
  units: Unit[];
}

/** Wall-clock time spent in each pipeline function, per fixture. */
type Timings = Record<string, { ms: number; calls: number }>;
let current: Timings = {};
const timed = <A extends unknown[], R>(name: string, fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
  const t0 = performance.now();
  try {
    return await fn(...a);
  } finally {
    const t = (current[name] ??= { ms: 0, calls: 0 });
    t.ms += performance.now() - t0;
    t.calls += 1;
  }
};

function instrument(p: Pipeline): Pipeline {
  const a = p.analyze;
  const analyze: AnalyzeApi = {
    ingestClip: timed('analyze.ingestClip', a.ingestClip.bind(a)),
    buildConcatProxy: timed('analyze.buildConcatProxy', a.buildConcatProxy.bind(a)),
    ingestBroll: timed('analyze.ingestBroll', a.ingestBroll.bind(a)),
    transcribeClip: timed('analyze.transcribeClip', a.transcribeClip.bind(a)),
    detectSilence: timed('analyze.detectSilence', a.detectSilence.bind(a)),
    decideEdit: timed('analyze.decideEdit', a.decideEdit.bind(a)),
    replan: timed('analyze.replan', a.replan.bind(a)),
    suggestStockBroll: timed('analyze.suggestStockBroll', a.suggestStockBroll.bind(a)),
  };
  const templates: TemplatesApi = {
    renderGraphic: timed('templates.renderGraphic', p.templates.renderGraphic.bind(p.templates)),
    renderGraphicStill: p.templates.renderGraphicStill.bind(p.templates),
  };
  const render: RenderApi = {
    renderVideo: timed('render.renderVideo', async (input) => {
      const t0 = performance.now();
      const g0 = current['templates.renderGraphic']?.ms ?? 0;
      const out = await p.render.renderVideo({ ...input, renderGraphic: templates.renderGraphic });
      const stages = (renderModule?.renderTimings.last ?? null) as Record<string, number> | null;
      renderLog.push({
        quality: input.quality,
        variantId: input.variantId ?? null,
        sec: (performance.now() - t0) / 1000,
        graphicsSec: ((current['templates.renderGraphic']?.ms ?? 0) - g0) / 1000,
        stagesSec: stages ? Object.fromEntries(Object.entries(stages).map(([k, v]) => [k.replace(/Ms$/, ''), k === 'chunks' ? v : Math.round(v) / 1000])) : null,
      });
      return out;
    }),
  };
  return { analyze, render, templates };
}

interface RenderLogEntry {
  quality: string;
  variantId: string | null;
  sec: number;
  graphicsSec: number;
  stagesSec: Record<string, number> | null;
}
let renderLog: RenderLogEntry[] = [];
let renderModule: { renderTimings: { last: unknown } } | null = null;

const execFileP = promisify(execFile);

/** A keep-alive connection closed by the server just as a request goes out: worth one more try. */
const transient = (err: unknown) => /ECONNRESET|socket hang up|fetch failed/.test(`${(err as Error)?.message} ${String((err as { cause?: unknown })?.cause)}`);

async function poll<T>(fn: () => Promise<T | null | undefined | false>, what: string, timeoutMs: number, everyMs = 250): Promise<T> {
  const start = Date.now();
  for (;;) {
    let v: T | null | undefined | false;
    try {
      v = await fn();
    } catch (err) {
      if (!transient(err)) throw err;
      v = null;
    }
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** Waits for a status, recording analysis progress on the way; fails on `failed`. */
async function waitForStatusWatching(client: Client, id: string, status: string, timeoutMs: number) {
  const progress: number[] = [];
  const detail = await poll(async () => {
    const d = await client.ok(VideoDetail, 'GET', `/v1/videos/${id}`);
    if (d.status === 'failed') throw new Error(`video failed: ${d.error}`);
    if (d.status === 'queued' || d.status === 'analyzing') {
      expect(d.progress).not.toBeNull();
      progress.push(d.progress!);
    } else expect(d.progress).toBeNull();
    return d.status === status ? d : null;
  }, `video to be ${status}`, timeoutMs);
  return { detail, progress };
}

interface Probed {
  width: number;
  height: number;
  fps: number;
  duration: number;
  frames: number;
  audioCodec?: string;
  audioRate?: number;
}

// Media checks run as async child processes: the API and worker share this process, and a
// blocked event loop would stall them.
async function probe(path: string): Promise<Probed> {
  const json = JSON.parse((await execFileP('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', path], { maxBuffer: 1 << 26 })).stdout);
  const v = json.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
  const a = json.streams.find((s: { codec_type: string }) => s.codec_type === 'audio');
  const [n, d] = String(v.r_frame_rate).split('/').map(Number);
  return {
    width: v.width,
    height: v.height,
    fps: n! / d!,
    duration: Number(v.duration),
    frames: Number(v.nb_read_frames),
    audioCodec: a?.codec_name,
    audioRate: a ? Number(a.sample_rate) : undefined,
  };
}

async function loudness(path: string): Promise<number> {
  const stderr = await new Promise<string>((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-nostats', '-threads', '2', '-i', path, '-af', 'ebur128', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString();
      if (err.length > 4_000_000) err = err.slice(-1_000_000);
    });
    child.on('error', reject);
    child.on('close', () => resolve(err));
  });
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  return Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1]);
}

/**
 * The fixtures paint an orange band over every cut unit, including pauses ("CUT
 * dead_air (silence)"). A natural edit keeps a little of each pause (cut padding and
 * breathing room between lines), so orange frames on kept pause are expected; the
 * check is that no frame shows a cut *line*, traced through the timeline, and that
 * the pixels agree with that tracing.
 *
 * Per frame, the share of the lower part of the picture that is the fixtures' orange
 * cut band (#B4441E at 90% over the dark ground). The band sits at 0.62..0.88 of the
 * source height; a punch-in moves it, so the whole lower half is searched.
 */
async function orangeShares(path: string, w = 54, h = 96): Promise<number[]> {
  const raw = (
    await execFileP('ffmpeg', ['-v', 'error', '-threads', '2', '-i', path, '-vf', `scale=${w}:${h}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
      maxBuffer: 1 << 30,
      encoding: 'buffer',
    })
  ).stdout;
  const size = w * h * 3;
  const out: number[] = [];
  for (let f = 0; f + size <= raw.length; f += size) {
    let orange = 0;
    let n = 0;
    for (let y = Math.floor(h * 0.5); y < Math.floor(h * 0.97); y++) {
      for (let x = 0; x < w; x++) {
        const o = f + (y * w + x) * 3;
        const r = raw[o]!;
        const g = raw[o + 1]!;
        const b = raw[o + 2]!;
        if (r > 135 && g > 40 && g < 115 && b < 75 && r - g > 60) orange++;
        n++;
      }
    }
    out.push(orange / n);
  }
  return out;
}

/** Union of [start, end) ranges covers [a, b] (within eps)? */
function covered(ranges: Array<[number, number]>, a: number, b: number, eps = 1e-6): boolean {
  let t = a;
  for (const [s, e] of [...ranges].sort((x, y) => x[0] - y[0])) {
    if (s > t + eps) break;
    if (e > t) t = e;
    if (t >= b - eps) return true;
  }
  return t >= b - eps;
}

function overlapLen(ranges: Array<[number, number]>, a: number, b: number): number {
  return ranges.reduce((n, [s, e]) => n + Math.max(0, Math.min(b, e) - Math.max(a, s)), 0);
}

interface FixtureResult {
  fixture: string;
  mode: Mode;
  analysisSec: number;
  analysisSteps: Timings;
  cut: { keptUnits: number; keptUnitsFull: number; cutUnits: number; cutUnitsCut: number; clippedWords: number; problems: string[] };
  edl: { fps: number; segments: number; kept: number; overlays: string[]; variants: string[]; keptSec: number; totalSec: number };
  restored: { segmentId: string; reason: string; text: string };
  replanSec: number;
  preview: { sec: number; width: number; height: number; fps: number };
  finals: Array<{
    variantId: string | null; renderSec: number; graphicsSec: number; stagesSec: Record<string, number> | null; width: number; height: number; fps: number; durationSec: number; expectedSec: number; lufs: number;
    frames: number; cutSpeechFrames: number; orangeOnKeptPause: number; orangeInRestored: number; keptPauseFrames: number; longestKeptPauseSec: number;
  }>;
  renderSteps: Timings;
}

const results: FixtureResult[] = [];

describe.skipIf(!process.env.KILO_TEST_REAL)('acceptance: the real pipeline end to end on every fixture', () => {
  let env: TestEnv;
  let warmUpSec = 0;
  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true });
    // A cache of our own, emptied of graphics, so every graphic is rendered cold and timed.
    process.env.KILO_TEMPLATES_CACHE_DIR = join(OUT, 'templates-cache');
    rmSync(join(OUT, 'templates-cache', 'graphics'), { recursive: true, force: true });
    rmSync(join(OUT, 'templates-cache', 'stills'), { recursive: true, force: true });
    const spec = (name: string): string => name; // variable specifiers: these packages are not typechecked here
    renderModule = (await import(spec('@kilo/render'))) as typeof renderModule;
    const templatesModule = (await import(spec('@kilo/templates'))) as { warmUp(): Promise<void> };
    // Bundling the templates (first run only) and starting Chromium happen once per worker process.
    const tw = performance.now();
    await templatesModule.warmUp();
    warmUpSec = (performance.now() - tw) / 1000;
    env = await createEnv({ pipeline: instrument(await loadRealPipeline()) });
  }, 180_000);
  afterAll(async () => {
    await env?.stop();
    if (results.length) {
      writeFileSync(join(OUT, 'results.json'), JSON.stringify({ templatesWarmUpSec: warmUpSec, fixtures: results }, null, 2));
      const lines = ['', `templates warm-up (bundle + Chromium start, once per process): ${warmUpSec.toFixed(1)}s`, 'fixture     analysis  replan  preview  finals (s, each)          LUFS          kept units  cut units  clipped'];
      for (const r of results) {
        lines.push(
          `${r.fixture.padEnd(11)} ${r.analysisSec.toFixed(1).padStart(7)}s ${r.replanSec.toFixed(1).padStart(6)}s ${r.preview.sec.toFixed(1).padStart(7)}s  ` +
            `${r.finals.map((f) => f.renderSec.toFixed(1)).join(' / ').padEnd(24)} ${r.finals.map((f) => f.lufs.toFixed(1)).join(' ').padEnd(14)}` +
            `${`${r.cut.keptUnitsFull}/${r.cut.keptUnits}`.padStart(10)} ${`${r.cut.cutUnitsCut}/${r.cut.cutUnits}`.padStart(10)} ${String(r.cut.clippedWords).padStart(8)}`,
        );
      }
      console.log(lines.join('\n'));
    }
  }, 60_000);

  for (const id of ['routine', 'unboxing', 'mistakes']) {
    it(`${id}: analyse, score, edit, replan, render, check every frame`, async () => {
      current = {};
      const m = manifest(id) as unknown as { mode: Mode; clips: FixtureClip[]; broll: unknown[]; script: string[] | null };
      const mode = m.mode;
      const settings: EditSettings = { ...MODE_PRESETS[mode].settings, broll: true, graphics: true, captions: true, hookVariations: 3 };
      const user = env.as(newUser());

      // ---- create, upload, analyse -------------------------------------------------
      const t0 = performance.now();
      const created = await uploadFixtures(user, [id], { settings, broll: true });
      const video = created.videos[0]!;
      const { detail: ready, progress } = await waitForStatusWatching(user, video.videoId, 'ready_for_review', 900_000);
      const analysisSec = (performance.now() - t0) / 1000;
      const analysisSteps = current;
      for (let i = 1; i < progress.length; i++) expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);
      expect(ready.clipCount).toBe(m.clips.length);
      const edl0 = Edl.parse(ready.edl);
      expect(validateEdl(edl0, ready.clips)).toEqual([]);
      expect(edl0.revision).toBe(0);
      expect(edl0.variants).toHaveLength(3);
      expect(edl0.captions.enabled).toBe(true);
      expect(ready.broll.every((b) => b.status === 'ready' && b.width && b.height && b.description && b.filename)).toBe(true);
      expect(ready.broll).toHaveLength(m.broll.length);

      // ---- cut accuracy against the manifest ----------------------------------------
      const clipIdOf = new Map(m.clips.map((c, j) => [c.name, video.clips[j]!.clipId]));
      const cut = { keptUnits: 0, keptUnitsFull: 0, cutUnits: 0, cutUnitsCut: 0, clippedWords: 0, problems: [] as string[] };
      for (const mc of m.clips) {
        const clipId = clipIdOf.get(mc.name)!;
        const kept = edl0.segments.filter((s) => s.clipId === clipId && s.keep).map((s) => [s.start, s.end] as [number, number]);
        const words = (JSON.parse(readFileSync(join(FIXTURES, id, mc.wordsFile), 'utf8')) as Transcript).words;
        for (const u of mc.units) {
          if (u.kind === 'pause') continue;
          if (u.keep) {
            cut.keptUnits++;
            const inUnit = words.filter((w) => w.start >= u.start - 1e-3 && w.end <= u.end + 1e-3);
            const clipped = inUnit.filter((w) => !covered(kept, w.start, w.end));
            cut.clippedWords += clipped.length;
            if (!clipped.length) cut.keptUnitsFull++;
            else cut.problems.push(`${mc.name}: kept "${u.text}" lost ${clipped.map((w) => w.text).join(' ')}`);
          } else {
            cut.cutUnits++;
            const keptShare = overlapLen(kept, u.start, u.end) / (u.end - u.start);
            if (keptShare < 0.1) cut.cutUnitsCut++;
            else cut.problems.push(`${mc.name}: ${u.reason} "${u.text}" ${Math.round(keptShare * 100)}% kept`);
          }
        }
      }
      expect(cut.problems, cut.problems.join('\n')).toEqual([]);
      expect(cut.clippedWords).toBe(0);

      // ---- overlays the decider placed are sound -------------------------------------
      for (const o of [...edl0.overlays, ...edl0.variants.flatMap((v) => v.overlays)]) {
        if (o.type !== 'graphic') continue;
        const spec = getTemplate(o.template);
        expect(o.durationSec).toBeGreaterThanOrEqual(spec.minDurationSec);
        expect(o.durationSec).toBeLessThanOrEqual(spec.maxDurationSec);
      }
      if (m.broll.length) expect(edl0.overlays.some((o) => o.type === 'broll')).toBe(true);
      // The creator's own B-roll takes its line first and an automatic graphic in its way gives
      // way, so a short video full of B-roll may have no graphic in its base cut. Without B-roll
      // the base cut must have one; either way some cut carries a graphic, which is rendered below.
      if (!m.broll.length) expect(edl0.overlays.some((o) => o.type === 'graphic')).toBe(true);
      expect([...edl0.overlays, ...edl0.variants.flatMap((v) => v.overlays)].some((o) => o.type === 'graphic')).toBe(true);

      // ---- restore one cut segment and save -----------------------------------------
      const restoredSeg = edl0.segments.find((s) => !s.keep && (s.reason === 'retake' || s.reason === 'false_start') && s.end - s.start > 0.8) as Segment;
      expect(restoredSeg).toBeDefined();
      const edited = toggleSegment(edl0, restoredSeg.id);
      const saved = await user.ok(SaveEdlResponse, 'PUT', `/v1/videos/${video.videoId}/edl`, { edl: edited, baseRevision: 0 });
      expect(saved.edl.revision).toBe(1);
      expect(saved.edl.segments.find((s) => s.id === restoredSeg.id)).toMatchObject({ keep: true, userOverride: true, reason: restoredSeg.reason });

      // ---- replan ---------------------------------------------------------------------
      current = {};
      const tr = performance.now();
      await user.ok(VideoSummary, 'POST', `/v1/videos/${video.videoId}/replan`, { passes: ['broll', 'graphics', 'variants'] });
      const { detail: replanned } = await waitForStatusWatching(user, video.videoId, 'ready_for_review', 300_000);
      const replanSec = (performance.now() - tr) / 1000;
      const edl = Edl.parse(replanned.edl);
      expect(edl.revision).toBe(2);
      expect(edl.segments.map((s) => [s.id, s.keep, s.start, s.end])).toEqual(saved.edl.segments.map((s) => [s.id, s.keep, s.start, s.end]));
      expect(validateEdl(edl, replanned.clips)).toEqual([]);
      // The client still holding revision 1 is told to refetch.
      const stale = await user.req('PUT', `/v1/videos/${video.videoId}/edl`, { edl: saved.edl, baseRevision: 1 });
      expect(stale.status).toBe(409);
      expect(ApiError.parse(stale.body).error.code).toBe('revision_conflict');

      // ---- preview ----------------------------------------------------------------------
      current = {};
      renderLog = [];
      const waitRender = async (renderId: string) => {
        let startedAt = 0;
        const done = await poll(async () => {
          const r = await user.ok(RenderView, 'GET', `/v1/renders/${renderId}`);
          if (r.status === 'failed') throw new Error(`render failed: ${r.error}`);
          if (r.status === 'rendering' && !startedAt) startedAt = performance.now();
          return r.status === 'done' ? r : null;
        }, `render ${renderId}`, 900_000, 200);
        return { done, sec: (performance.now() - (startedAt || performance.now())) / 1000 };
      };
      const download = async (url: string, to: string) => {
        const res = await fetch(url);
        expect(res.status).toBe(200);
        writeFileSync(to, Buffer.from(await res.arrayBuffer()));
      };
      const dir = join(OUT, id);
      mkdirSync(dir, { recursive: true });
      const pv = await user.ok(CreateRenderResponse, 'POST', `/v1/videos/${video.videoId}/renders`, { quality: 'preview', variantIds: [null] }, 201);
      const pvDone = await waitRender(pv.renders[0]!.id);
      expect((await user.ok(VideoSummary, 'GET', `/v1/videos/${video.videoId}`)).status).toBe('ready_for_review');
      const pvPath = join(dir, 'preview.mp4');
      await download(pvDone.done.url!, pvPath);
      const pvProbe = await probe(pvPath);
      expect([pvProbe.width, pvProbe.height, pvProbe.fps]).toEqual([540, 960, Math.min(edl.fps, 30)]);

      // ---- finals of every variant ------------------------------------------------------
      const fr = await user.ok(CreateRenderResponse, 'POST', `/v1/videos/${video.videoId}/renders`, { quality: 'final' }, 201);
      expect(fr.renders.map((r) => r.variantId)).toEqual(edl.variants.map((v) => v.id));
      expect((await user.ok(VideoSummary, 'GET', `/v1/videos/${video.videoId}`)).status).toBe('rendering');
      const finals: FixtureResult['finals'] = [];
      for (const r of fr.renders) {
        const { done, sec } = await waitRender(r.id);
        const path = join(dir, `final-${r.variantId}.mp4`);
        await download(done.url!, path);
        const p = await probe(path);
        const tl = resolveTimeline(edl, r.variantId);
        expect(p.width).toBe(1080);
        expect(p.height).toBe(1920);
        expect(p.fps).toBe(edl.fps);
        expect(Math.abs(p.duration - tl.durationSec), `${r.variantId} duration`).toBeLessThanOrEqual(1 / edl.fps + 1e-6);
        expect(p.audioCodec).toBe('aac');
        expect(p.audioRate).toBe(48000);
        const lufs = await loudness(path);
        expect(Math.abs(lufs - -14), `${r.variantId} loudness ${lufs}`).toBeLessThanOrEqual(1.5);
        // Every frame, traced back to the fixture unit it shows. No frame may show a cut line
        // (speech, filler, false start, retake, chatter) except the restored segment.
        const unitOf = new Map(m.clips.map((c) => [clipIdOf.get(c.name)!, c.units]));
        const classify = (f: number): 'kept' | 'restored' | 'pause' | 'cut_speech' | 'none' => {
          const t = (f + 0.5) / edl.fps;
          const it = tl.items.find((i) => t >= i.outStart && t < i.outEnd) ?? tl.items[tl.items.length - 1]!;
          if (it.segment.id === restoredSeg.id) return 'restored';
          const src = it.segment.start + (t - it.outStart);
          const u = unitOf.get(it.segment.clipId)!.find((x) => src >= x.start && src < x.end);
          if (!u) return 'none';
          if (u.keep) return 'kept';
          return u.kind === 'pause' ? 'pause' : 'cut_speech';
        };
        const classes = Array.from({ length: p.frames }, (_, f) => classify(f));
        expect(classes.filter((c) => c === 'cut_speech').length, `${id} ${r.variantId}: frames of cut lines`).toBe(0);
        // Kept pause (breathing room and cut padding) is short wherever it occurs.
        const pauseRuns: number[] = [];
        classes.forEach((c, f) => {
          if (c !== 'pause') return;
          if (f > 0 && classes[f - 1] === 'pause') pauseRuns[pauseRuns.length - 1]! += 1;
          else pauseRuns.push(1);
        });
        const maxPause = PACING_PARAMS[edl.settings.pacing].keptPauseSec + 2 * PACING_PARAMS[edl.settings.pacing].cutPaddingSec + 2 / edl.fps;
        for (const run of pauseRuns) expect(run / edl.fps, `${id} ${r.variantId}: kept pause`).toBeLessThanOrEqual(maxPause + 1e-6);
        // The pixels agree: the orange band shows only on kept pause or the restored segment.
        const shares = await orangeShares(path);
        expect(shares.length).toBe(p.frames);
        const near = (f: number, ok: (c: string) => boolean) => [f - 1, f, f + 1].some((g) => g >= 0 && g < classes.length && ok(classes[g]!));
        const orange = shares.map((sh, f) => [sh, f] as const).filter(([sh]) => sh > 0.03);
        const unexpected = orange.filter(([, f]) => !near(f, (c) => c === 'pause' || c === 'restored'));
        expect(unexpected.map(([sh, f]) => `frame ${f} (${(f / edl.fps).toFixed(2)}s, ${classes[f]}) ${(sh * 100).toFixed(0)}%`), `${id} ${r.variantId}`).toEqual([]);
        const inRestored = orange.filter(([, f]) => classes[f] === 'restored').length;
        const pauseOrange = orange.length - inRestored;
        void sec;
        const logged = renderLog.find((e) => e.quality === 'final' && e.variantId === r.variantId);
        finals.push({
          variantId: r.variantId, renderSec: logged?.sec ?? NaN, graphicsSec: logged?.graphicsSec ?? NaN, stagesSec: logged?.stagesSec ?? null, width: p.width, height: p.height, fps: p.fps, durationSec: p.duration, expectedSec: tl.durationSec, lufs,
          frames: p.frames, cutSpeechFrames: 0, orangeOnKeptPause: pauseOrange, orangeInRestored: inRestored,
          keptPauseFrames: pauseRuns.reduce((a, b) => a + b, 0), longestKeptPauseSec: Math.max(0, ...pauseRuns) / edl.fps,
        });
      }
      expect(finals.some((f) => f.orangeInRestored > 0), 'the orange detector never fired on the restored segment').toBe(true);
      const after = await user.ok(VideoSummary, 'GET', `/v1/videos/${video.videoId}`);
      expect(after.status).toBe('done');
      await copyFile(join(dir, `final-${fr.renders[0]!.variantId}.mp4`), join(OUT, `${id}-final.mp4`));

      results.push({
        fixture: id,
        mode,
        analysisSec,
        analysisSteps,
        cut,
        edl: {
          fps: edl.fps,
          segments: edl.segments.length,
          kept: edl.segments.filter((s) => s.keep).length,
          overlays: edl.overlays.map((o) => (o.type === 'graphic' ? o.template : `broll:${o.kenBurns ? 'still' : 'video'}`)),
          variants: edl.variants.map((v) => `${v.id}: ${v.hookText}`),
          keptSec: replanned.keptSec!,
          totalSec: replanned.totalSec!,
        },
        restored: { segmentId: restoredSeg.id, reason: restoredSeg.reason, text: restoredSeg.text },
        replanSec,
        preview: { sec: renderLog.find((e) => e.quality === 'preview')?.sec ?? pvDone.sec, width: pvProbe.width, height: pvProbe.height, fps: pvProbe.fps },
        finals,
        renderSteps: current,
      });
    }, 1_800_000);
  }
});
