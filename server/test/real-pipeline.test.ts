import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApiError,
  CreateRenderResponse,
  Edl,
  MODE_PRESETS,
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
    renderVideo: timed('render.renderVideo', (input) => p.render.renderVideo({ ...input, renderGraphic: templates.renderGraphic })),
  };
  return { analyze, render, templates };
}

async function poll<T>(fn: () => Promise<T | null | undefined | false>, what: string, timeoutMs: number, everyMs = 250): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
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

function probe(path: string): Probed {
  const json = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', path]).toString());
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

function loudness(path: string): number {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-threads', '2', '-i', path, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const summary = r.stderr.slice(r.stderr.lastIndexOf('Summary:'));
  return Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1]);
}

/**
 * Per frame, the share of the lower part of the picture that is the fixtures' orange
 * cut band (#B4441E at 90% over the dark ground). The band sits at 0.62..0.88 of the
 * source height; a punch-in moves it, so the whole lower half is searched.
 */
function orangeShares(path: string, w = 54, h = 96): number[] {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-threads', '2', '-i', path, '-vf', `scale=${w}:${h}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
    maxBuffer: 1 << 30,
  });
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
  finals: Array<{ variantId: string | null; renderSec: number; width: number; height: number; fps: number; durationSec: number; expectedSec: number; lufs: number; orangeFrames: number; orangeInRestored: number; frames: number }>;
  renderSteps: Timings;
}

const results: FixtureResult[] = [];

describe.skipIf(!process.env.KILO_TEST_REAL)('acceptance: the real pipeline end to end on every fixture', () => {
  let env: TestEnv;
  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true });
    env = await createEnv({ pipeline: instrument(await loadRealPipeline()) });
  }, 180_000);
  afterAll(async () => {
    await env?.stop();
    if (results.length) {
      writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2));
      const lines = ['', 'fixture     analysis  replan  preview  finals (s, each)          LUFS          kept units  cut units  clipped'];
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
      const m = manifest(id) as ReturnType<typeof manifest> & { mode: Mode; clips: FixtureClip[] };
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
      expect(edl0.overlays.some((o) => o.type === 'graphic')).toBe(true);

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
      const pvProbe = probe(pvPath);
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
        const p = probe(path);
        const tl = resolveTimeline(edl, r.variantId);
        expect(p.width).toBe(1080);
        expect(p.height).toBe(1920);
        expect(p.fps).toBe(edl.fps);
        expect(Math.abs(p.duration - tl.durationSec), `${r.variantId} duration`).toBeLessThanOrEqual(1 / edl.fps + 1e-6);
        expect(p.audioCodec).toBe('aac');
        expect(p.audioRate).toBe(48000);
        const lufs = loudness(path);
        expect(Math.abs(lufs - -14), `${r.variantId} loudness ${lufs}`).toBeLessThanOrEqual(1.5);
        // No orange band in any frame, except while the restored segment plays.
        const item = tl.items.find((i) => i.segment.id === restoredSeg.id)!;
        const allowed: [number, number] = [Math.floor(item.outStart * edl.fps) - 1, Math.ceil(item.outEnd * edl.fps) + 1];
        const shares = orangeShares(path);
        expect(shares.length).toBe(p.frames);
        const orange = shares.map((s, f) => [s, f] as const).filter(([s]) => s > 0.03);
        const outside = orange.filter(([, f]) => f < allowed[0] || f > allowed[1]);
        expect(outside.map(([s, f]) => `frame ${f} (${(f / edl.fps).toFixed(2)}s) ${(s * 100).toFixed(0)}%`), `${id} ${r.variantId}`).toEqual([]);
        // The detector does see the band where it should be (unless an overlay covers that line).
        const inRestored = orange.length - outside.length;
        finals.push({ variantId: r.variantId, renderSec: sec, width: p.width, height: p.height, fps: p.fps, durationSec: p.duration, expectedSec: tl.durationSec, lufs, orangeFrames: outside.length, orangeInRestored: inRestored, frames: p.frames });
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
        preview: { sec: pvDone.sec, width: pvProbe.width, height: pvProbe.height, fps: pvProbe.fps },
        finals,
        renderSteps: current,
      });
    }, 1_800_000);
  }
});
