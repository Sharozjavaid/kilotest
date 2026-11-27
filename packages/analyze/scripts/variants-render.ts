import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Edl, RenderApi, RenderInput, TemplatesApi } from '@kilo/edl';
import { resolveTimeline } from '@kilo/edl';
import { findFixtures, PKG, REPO, scoreFixture, type FixtureScore } from './scoring.js';

/**
 * Phase 5 acceptance, render part. For the chosen fixture recordings, every hook
 * variant (hookVariations 3) is rendered with @kilo/render, graphics drawn by the
 * real @kilo/templates, and each output is checked:
 *
 * - probe: duration matches resolveTimeline for that variant (within 0.1 s);
 * - "starts with its own hook": the first second of the output's sound matches the
 *   source sound of that variant's first segment (normalised cross-correlation, lag
 *   search +-60 ms) better than any other variant's first segment;
 * - "contains only kept content", sound: the whole output's sound, in 0.5 s windows,
 *   matches the variant's kept segments laid end to end in order (each speech window
 *   must correlate >= 0.8; windows that straddle a segment boundary may be softened by
 *   a crossfade and are reported, not failed);
 * - "contains only kept content", picture: frames sampled every 0.2 s (outside B-roll
 *   and graphics, and away from cuts) are traced back through the timeline to the
 *   fixture unit they should show. The fixtures paint a blue band over kept speech and
 *   a red one over cut speech and pauses: no frame may show red unless it traces to a
 *   pause (kept padding), and at least 90% of frames that trace to kept speech must
 *   show blue, which also proves the tracing lines up with the picture.
 *
 * The packages are loaded from their source folders (no dependency between them).
 */

const RENDER_SRC = join(REPO, 'packages/render/src/index.ts');
const TEMPLATES_SRC = join(REPO, 'templates/src/index.ts');
const WORK = join(PKG, '.work/variants-render');
const SR = 16000;
export const DEFAULT_RENDER_FIXTURES = ['az_backtoback', 'az_fillers', 'az_takes'];

interface TemplatesModule {
  templates: TemplatesApi;
  shutdown(): Promise<void>;
}

export interface RenderedVariant {
  fixture: string;
  variantId: string;
  hookText: string;
  outPath: string;
  renderSec: number;
  expectedSec: number;
  probedSec: number;
  /** Correlation of the output's first second with each variant's first segment. */
  openingScores: Record<string, number>;
  speechWindows: number;
  speechWindowsMatched: number;
  boundaryWindowsSoft: number;
  worstWindow: { at: number; score: number } | null;
  framesChecked: number;
  framesWithCutBand: number[];
  /** Sampled frames that play kept speech, and how many of them show the fixtures' blue kept band. */
  keptFrames: number;
  keptFramesBlue: number;
  problems: string[];
}

function pcm(path: string, start?: number, dur?: number): Float32Array {
  const args = ['-v', 'error', ...(start !== undefined ? ['-ss', start.toFixed(4)] : []), '-i', path, ...(dur !== undefined ? ['-t', dur.toFixed(4)] : []), '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'];
  const buf = execFileSync('ffmpeg', args, { maxBuffer: 1 << 30 });
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

/**
 * Max normalised cross-correlation of `a` against `b` placed at `offset` samples into
 * `b`, over lags within +-maxLag samples (gain-independent, so loudness levelling does
 * not matter).
 */
function xcorr(a: Float32Array, b: Float32Array, offset = 0, maxLag = Math.round(0.06 * SR)): number {
  const at = (lag: number) => {
    let ab = 0;
    let aa = 0;
    let bb = 0;
    for (let i = 0; i < a.length; i++) {
      const j = offset + i + lag;
      if (j < 0 || j >= b.length) continue;
      const x = a[i]!;
      const y = b[j]!;
      ab += x * y;
      aa += x * x;
      bb += y * y;
    }
    return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : -1;
  };
  // Speech correlates over a fraction of a millisecond: a coarse grid, then every sample around its best.
  let best = -1;
  let bestLag = 0;
  for (let lag = -maxLag; lag <= maxLag; lag += 2) {
    const c = at(lag);
    if (c > best) [best, bestLag] = [c, lag];
  }
  for (let lag = bestLag - 1; lag <= bestLag + 1; lag++) best = Math.max(best, at(lag));
  return best;
}

const rms = (a: Float32Array) => Math.sqrt(a.reduce((n, x) => n + x * x, 0) / Math.max(1, a.length));

/** The sound the variant should play: its segments' source audio laid end to end. */
function expectedAudio(edl: Edl, variantId: string, audioOf: Map<string, Float32Array>): { pcm: Float32Array; boundaries: number[] } {
  const items = resolveTimeline(edl, variantId).items;
  const parts: Float32Array[] = [];
  const boundaries: number[] = [];
  for (const it of items) {
    const src = audioOf.get(it.segment.clipId)!;
    parts.push(src.subarray(Math.round(it.segment.start * SR), Math.round(it.segment.end * SR)));
    boundaries.push(it.outEnd);
  }
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return { pcm: out, boundaries };
}

/** Frames every `every` seconds at 54x96, RGB. */
function sampleFrames(path: string, every: number): Buffer[] {
  const w = 54;
  const h = 96;
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-vf', `fps=${1 / every},scale=${w}:${h}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 30 });
  const size = w * h * 3;
  const out: Buffer[] = [];
  for (let i = 0; i + size <= raw.length; i += size) out.push(raw.subarray(i, i + size));
  return out;
}

/** Share of the lower picture that is the fixtures' blue kept band (0x1F5EFF). */
function keptBandShare(frame: Buffer): number {
  const w = 54;
  const h = 96;
  let blue = 0;
  let n = 0;
  for (let y = Math.floor(h * 0.55); y < Math.floor(h * 0.95); y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      n++;
      if (frame[o + 2]! > 170 && frame[o]! < 90 && frame[o + 1]! > 50 && frame[o + 1]! < 140) blue++;
    }
  }
  return blue / n;
}

/** Share of the lower picture that is the fixtures' red cut band (0xB4441E). */
function cutBandShare(frame: Buffer): number {
  const w = 54;
  const h = 96;
  let red = 0;
  let n = 0;
  for (let y = Math.floor(h * 0.55); y < Math.floor(h * 0.95); y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      const r = frame[o]!;
      const g = frame[o + 1]!;
      const b = frame[o + 2]!;
      n++;
      if (r > 130 && r < 230 && g > 30 && g < 110 && b < 70 && r - g > 70) red++;
    }
  }
  return red / n;
}

export async function renderVariants(opts: { fixtures?: string[]; quality?: 'preview' | 'final'; log?: (m: string) => void } = {}): Promise<RenderedVariant[]> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const wanted = opts.fixtures ?? DEFAULT_RENDER_FIXTURES;
  const dirs = findFixtures().filter((d) => wanted.includes(d.split('/').pop()!));
  const { render } = (await import(pathToFileURL(RENDER_SRC).href)) as { render: RenderApi };
  const tpl = (await import(pathToFileURL(TEMPLATES_SRC).href)) as TemplatesModule;
  const results: RenderedVariant[] = [];
  try {
    for (const dir of dirs) {
      const fixture = dir.split('/').pop()!;
      const score: FixtureScore = await scoreFixture(dir, { settings: { hookVariations: 3 } });
      const edl = score.edl;
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
        clips: Array<{ name: string; units: Array<{ kind: string; start: number; end: number; keep: boolean }> }>;
      };
      const clips: RenderInput['clips'] = Object.fromEntries(score.ingested.map((c) => [c.info.id, { path: c.normalizedPath, info: c.info }]));
      const broll: RenderInput['broll'] = Object.fromEntries(score.broll.map((b) => [b.asset.id, { path: b.normalizedPath, asset: b.asset }]));
      const audioOf = new Map(score.ingested.map((c) => [c.info.id, pcm(c.audioPath)]));
      const firstAudio = new Map(
        edl.variants.map((v) => {
          const seg = edl.segments.find((s) => s.id === v.segmentOrder[0])!;
          const src = audioOf.get(seg.clipId)!;
          const len = Math.min(1.0, seg.end - seg.start);
          return [v.id, src.subarray(Math.round(seg.start * SR), Math.round((seg.start + len) * SR))] as const;
        }),
      );
      for (const v of edl.variants) {
        const outDir = join(WORK, fixture);
        mkdirSync(outDir, { recursive: true });
        const outPath = join(outDir, `${v.id}.mp4`);
        const t0 = Date.now();
        await render.renderVideo({
          edl, variantId: v.id, quality: opts.quality ?? 'preview', clips, broll, transcripts: score.input.transcripts,
          outPath, workDir: join(outDir, `work-${v.id}`), renderGraphic: tpl.templates.renderGraphic,
        });
        const renderSec = (Date.now() - t0) / 1000;
        const tl = resolveTimeline(edl, v.id);
        const problems: string[] = [];
        const probedSec = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', outPath]).toString());
        if (Math.abs(probedSec - tl.durationSec) > 0.1) problems.push(`lasts ${probedSec.toFixed(2)} s, the timeline ${tl.durationSec.toFixed(2)} s`);

        const got = pcm(outPath);
        // Opening: the output's first second against every variant's first segment.
        const head = got.subarray(0, Math.round(1.0 * SR));
        const openingScores: Record<string, number> = {};
        for (const [id, a] of firstAudio) openingScores[id] = xcorr(a, head, 0);
        const own = openingScores[v.id]!;
        const rival = Math.max(-1, ...Object.entries(openingScores).filter(([id]) => {
          const a = edl.variants.find((x) => x.id === id)!.segmentOrder[0];
          return a !== v.segmentOrder[0];
        }).map(([, s]) => s));
        if (own < 0.8) problems.push(`its first second matches its own hook only at ${own.toFixed(2)}`);
        if (rival >= own - 0.2) problems.push(`its first second matches another variant's hook (${rival.toFixed(2)}) about as well as its own (${own.toFixed(2)})`);

        // Whole sound against the kept segments in this variant's order.
        const { pcm: want, boundaries } = expectedAudio(edl, v.id, audioOf);
        const win = Math.round(0.5 * SR);
        const peak = rms(want);
        let speechWindows = 0;
        let matched = 0;
        let soft = 0;
        let worst: RenderedVariant['worstWindow'] = null;
        for (let i = 0; i + win <= Math.min(want.length, got.length); i += Math.round(0.25 * SR)) {
          const a = want.subarray(i, i + win);
          if (rms(a) < 0.35 * peak) continue; // silence and the noise floor say nothing
          speechWindows++;
          const score = xcorr(a, got, i);
          const at = i / SR;
          if (!worst || score < worst.score) worst = { at, score };
          if (score >= 0.8) matched++;
          else if (boundaries.some((b) => b > at - 0.1 && b < at + 0.6)) soft++;
          else problems.push(`sound at ${at.toFixed(2)} s does not match the kept content (${score.toFixed(2)})`);
        }

        // Picture: trace each sampled frame back to the source unit it should show.
        const every = 0.2;
        const frames = sampleFrames(outPath, every);
        const covered = (t: number) => tl.overlays.some((o) => t >= o.outStart - 0.05 && t <= o.outEnd + 0.05);
        const bad: number[] = [];
        let checked = 0;
        let keptFrames = 0;
        let keptFramesBlue = 0;
        frames.forEach((f, k) => {
          const t = k * every + every / 2;
          if (covered(t)) return;
          const item = tl.items.find((it) => t >= it.outStart && t < it.outEnd);
          if (!item) return;
          // Frames within a frame or two of a cut may still show the neighbour's picture.
          if (t - item.outStart < 0.05 || item.outEnd - t < 0.05) return;
          checked++;
          const srcT = item.segment.start + (t - item.outStart);
          const mc = manifest.clips.find((c) => `${fixture}-${c.name}` === item.segment.clipId);
          const unit = mc?.units.find((u) => srcT >= u.start - 0.02 && srcT <= u.end + 0.02);
          const red = cutBandShare(f) > 0.08;
          if (unit && unit.kind !== 'pause' && unit.keep) {
            keptFrames++;
            if (keptBandShare(f) > 0.08) keptFramesBlue++;
          }
          // The fixtures paint pauses red as well: a red band is wrong only over cut speech,
          // or where the EDL says a kept word is playing.
          if (red && (!unit || unit.kind !== 'pause')) bad.push(Number(t.toFixed(2)));
        });
        if (bad.length) problems.push(`cut content shows at ${bad.join(', ')} s`);
        if (keptFrames && keptFramesBlue < 0.9 * keptFrames) problems.push(`only ${keptFramesBlue}/${keptFrames} frames of kept speech show the kept band`);
        const r: RenderedVariant = {
          fixture, variantId: v.id, hookText: v.hookText, outPath, renderSec, expectedSec: tl.durationSec, probedSec, openingScores,
          speechWindows, speechWindowsMatched: matched, boundaryWindowsSoft: soft, worstWindow: worst, framesChecked: checked,
          framesWithCutBand: bad, keptFrames, keptFramesBlue, problems,
        };
        results.push(r);
        log(formatRendered(r));
      }
    }
  } finally {
    await tpl.shutdown();
  }
  return results;
}

export function formatRendered(r: RenderedVariant): string {
  const scores = Object.entries(r.openingScores).map(([id, s]) => `${id} ${s.toFixed(2)}`).join(', ');
  return [
    `${r.fixture} ${r.variantId}: rendered in ${r.renderSec.toFixed(1)} s, ${r.probedSec.toFixed(2)} s long (timeline ${r.expectedSec.toFixed(2)} s); ` +
      `opening match [${scores}]; sound ${r.speechWindowsMatched}/${r.speechWindows} speech windows match` +
      `${r.boundaryWindowsSoft ? ` (${r.boundaryWindowsSoft} at a segment boundary softer)` : ''}` +
      `${r.worstWindow ? `, worst ${r.worstWindow.score.toFixed(2)} at ${r.worstWindow.at.toFixed(2)} s` : ''}; ` +
      `${r.framesChecked} frames traced, ${r.framesWithCutBand.length} show cut content, ${r.keptFramesBlue}/${r.keptFrames} kept-speech frames show the kept band` +
      `${r.problems.length ? `\n    PROBLEMS: ${r.problems.join('; ')}` : ' -> ok'}`,
    `    hook "${r.hookText}" -> ${resolve(r.outPath)}`,
  ].join('\n');
}
