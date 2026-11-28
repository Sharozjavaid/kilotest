import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PACING_PARAMS,
  Transcript,
  clipOffsets,
  getGraphicTheme,
  resolveTimeline,
  type AnalyzeApi,
  type BrollAsset,
  type BrollOverlay,
  type ClipInfo,
  type DecideInput,
  type Edl,
  type GraphicOverlay,
  type IngestedClip,
  type Overlay,
  type RenderApi,
  type Segment,
  type SegmentReason,
  type SilenceGap,
  type StockCandidate,
  type TemplatesApi,
  type Variant,
} from '@kilo/edl';
import { ffmpeg, ffprobe, nominalFps } from '../media.js';
import type { AnalyzeExtras, Pipeline } from './types.js';

/**
 * Fast stand-ins for @kilo/analyze, @kilo/render and @kilo/templates. They do the
 * minimum real media work (ffprobe, a WAV and a thumbnail per clip, a stream-copied
 * proxy, a tiny real MP4 per render) and build EDLs from the fixtures' ground truth.
 * Each method is a plain closure, so tests can wrap or replace any of them.
 */

const DEFAULT_FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'out');
const WORDS_TAG = 'kilo-words:';

interface ManifestUnit {
  start: number;
  end: number;
  keep: boolean;
  reason: SegmentReason;
  text: string;
}
interface ManifestClip {
  name: string;
  durationSec: number;
  wordsFile: string;
  units: ManifestUnit[];
}

/** The same words as @kilo/analyze's NO_SPEECH_MESSAGE. */
export const FAKE_NO_SPEECH_MESSAGE = "We couldn't hear any speech in this video, so nothing was cut";

export interface FakeOptions {
  /** Where fixture manifests live (default `<repo>/fixtures/out`). */
  fixturesDir?: string;
  /** What suggestStockBroll returns (default none). */
  stockCandidates?: StockCandidate[];
}

const round = (n: number) => Math.round(n * 1000) / 1000;

function loadFixtureClips(dir: string): { clip: ManifestClip; words: Transcript }[] {
  if (!existsSync(dir)) return [];
  const out: { clip: ManifestClip; words: Transcript }[] = [];
  for (const id of readdirSync(dir)) {
    const manifestPath = join(dir, id, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { clips: ManifestClip[] };
    for (const clip of manifest.clips) {
      const wordsPath = join(dir, id, clip.wordsFile);
      if (!existsSync(wordsPath)) continue;
      out.push({ clip, words: Transcript.parse(JSON.parse(readFileSync(wordsPath, 'utf8'))) });
    }
  }
  return out;
}

/** Finds the fixture clip a transcript came from, by duration and word timings. */
function matchFixture(
  fixtures: { clip: ManifestClip; words: Transcript }[],
  transcript: Transcript,
): ManifestClip | undefined {
  if (!transcript.words.length) return undefined;
  return fixtures.find(
    ({ clip, words }) =>
      Math.abs(clip.durationSec - transcript.durationSec) < 0.05 &&
      words.words.length === transcript.words.length &&
      words.words.every((w, i) => w.text === transcript.words[i]!.text && Math.abs(w.start - transcript.words[i]!.start) < 0.01),
  )?.clip;
}

function sidecarOf(audioPath: string): string {
  return audioPath.replace(/\.wav$/i, '') + '.words.json';
}

/** Segments for one clip that partition 0..duration. */
function segmentsForClip(clip: ClipInfo, transcript: Transcript | undefined, manifest: ManifestClip | undefined): Omit<Segment, 'id'>[] {
  const D = clip.durationSec;
  const base = { clipId: clip.id, zoom: 1, transitionIn: 'cut' as const, userOverride: false, scriptLineIndex: clip.scriptLineIndex };
  if (!manifest) {
    const text = (transcript?.words ?? []).map((w) => w.text).join(' ');
    return [{ ...base, start: 0, end: D, keep: true, reason: 'speech', text }];
  }
  const units = [...manifest.units].sort((a, b) => a.start - b.start).filter((u) => u.start < D - 0.001);
  const segs: Omit<Segment, 'id'>[] = [];
  let t = 0;
  units.forEach((u) => {
    const start = Math.max(u.start, t);
    if (start > t + 0.001) {
      const prev = segs[segs.length - 1];
      if (prev?.keep && u.keep) prev.end = round(start);
      else segs.push({ ...base, start: round(t), end: round(start), keep: false, reason: 'dead_air', text: '' });
    }
    const end = Math.min(u.end, D);
    if (end > start + 0.001) {
      segs.push({
        ...base,
        start: round(start),
        end: round(end),
        keep: u.keep,
        reason: u.keep ? 'speech' : u.reason === 'speech' ? 'retake' : u.reason,
        text: u.text,
      });
      t = end;
    }
  });
  if (D > t + 0.001) {
    segs.push({ ...base, start: round(t), end: D, keep: false, reason: 'dead_air', text: '' });
  }
  // Make the partition exact at the ends after rounding.
  if (segs.length) {
    segs[0]!.start = 0;
    segs[segs.length - 1]!.end = D;
  }
  return segs;
}

function placeBroll(segments: Segment[], broll: BrollAsset[]): BrollOverlay[] {
  const kept = segments.filter((s) => s.keep);
  if (!kept.length) return [];
  // Each file on its own kept segment (from the second on), never longer than it, so overlays never
  // overlap: the server refuses an EDL that breaks checkOverlayRules.
  const free = kept.slice(1).filter((s) => s.end - s.start >= 0.5);
  if (!free.length) free.push(kept[kept.length - 1]!);
  return broll.flatMap((asset, i) => {
    const anchor = free[i];
    if (!anchor) return [];
    const len = anchor.end - anchor.start;
    const durationSec = Math.floor(Math.min(2, len, Math.max(0.5, asset.durationSec ?? 2)) * 1000) / 1000;
    const overlay: BrollOverlay = {
      id: `ov-broll-${asset.id}`,
      type: 'broll',
      anchorSegmentId: anchor.id,
      offsetSec: 0,
      durationSec,
      assetId: asset.id,
      sourceStartSec: 0,
    };
    if (asset.kind === 'image') overlay.kenBurns = { fromScale: 1, toScale: 1.1, fromX: 0, fromY: 0, toX: 0.1, toY: 0 };
    return [overlay];
  });
}

function placeGraphics(segments: Segment[]): GraphicOverlay[] {
  const first = segments.find((s) => s.keep && s.text.trim());
  if (!first) return [];
  const text = first.text.trim().slice(0, 60);
  return [
    {
      id: 'ov-graphic-hook',
      type: 'graphic',
      template: 'bold-title',
      props: { text },
      anchorSegmentId: first.id,
      offsetSec: 0,
      durationSec: round(Math.max(1, Math.min(1.6, first.end - first.start))),
    },
  ];
}

function buildVariants(segments: Segment[], count: number): Variant[] {
  if (count <= 1) return [];
  const kept = segments.filter((s) => s.keep);
  const variants: Variant[] = [];
  for (let i = 0; i < Math.min(count, kept.length); i++) {
    const hook = kept[i]!;
    variants.push({
      id: `hook-${String.fromCharCode(97 + i)}`,
      label: `Hook ${String.fromCharCode(65 + i)}`,
      hookText: hook.text,
      segmentOrder: [hook.id, ...kept.filter((s) => s.id !== hook.id).map((s) => s.id)],
      overlays: [],
      hiddenOverlayIds: [],
    });
  }
  return variants;
}

export function createFakeAnalyze(options: FakeOptions = {}): AnalyzeApi & AnalyzeExtras {
  const fixturesDir = options.fixturesDir ?? DEFAULT_FIXTURES;
  let fixtures: { clip: ManifestClip; words: Transcript }[] | undefined;
  const getFixtures = () => (fixtures ??= loadFixtureClips(fixturesDir));

  const decide = (input: DecideInput): Edl => {
    const clips = [...input.clips].sort((a, b) => a.order - b.order);
    const params = PACING_PARAMS[input.settings.pacing];
    const segments: Segment[] = [];
    for (const clip of clips) {
      const transcript = input.transcripts.find((t) => t.clipId === clip.id);
      const manifest = transcript ? matchFixture(getFixtures(), transcript) : undefined;
      segmentsForClip(clip, transcript, manifest).forEach((s, i) => segments.push({ ...s, id: `${clip.id}-s${i}` }));
    }
    let keptIndex = 0;
    for (const s of segments) {
      if (!s.keep) continue;
      if (input.settings.zoomAndTransitions && keptIndex % 2 === 1) s.zoom = params.punchInScale;
      keptIndex += 1;
    }
    const overlays: Overlay[] = [
      ...(input.settings.broll ? placeBroll(segments, input.broll) : []),
      ...(input.settings.graphics ? placeGraphics(segments) : []),
    ];
    return {
      version: 1,
      videoId: input.videoId,
      revision: 0,
      fps: Math.min(60, Math.max(...clips.map((c) => c.fps), 24)),
      width: 1080,
      height: 1920,
      settings: input.settings,
      segments,
      overlays,
      captions: { enabled: input.settings.captions, style: input.settings.captionStyle },
      variants: buildVariants(segments, input.settings.hookVariations),
      decidedBy: 'heuristic',
    };
  };

  return {
    async ingestClip({ clipId, order, inputPath, workDir, scriptLineIndex, takeNumber }) {
      const dir = join(workDir, clipId);
      await mkdir(dir, { recursive: true });
      const probe = await ffprobe(inputPath);
      if (!probe.hasVideo || !probe.width || !probe.height) throw new Error(`No video stream in ${inputPath}`);
      const normalizedPath = join(dir, 'normalized.mp4');
      const audioPath = join(dir, 'audio.wav');
      const thumbnailPath = join(dir, 'thumb.jpg');
      await copyFile(inputPath, normalizedPath);
      const audioArgs = probe.hasAudio
        ? ['-i', inputPath, '-map', '0:a:0']
        : ['-f', 'lavfi', '-t', String(probe.durationSec), '-i', 'anullsrc=r=16000:cl=mono'];
      await ffmpeg([...audioArgs, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audioPath]);
      await ffmpeg(['-ss', '0.1', '-i', inputPath, '-frames:v', '1', '-vf', 'scale=180:-2', thumbnailPath]);
      if (probe.comment?.startsWith(WORDS_TAG)) {
        const json = Buffer.from(probe.comment.slice(WORDS_TAG.length), 'base64').toString('utf8');
        await writeFile(sidecarOf(audioPath), json);
      }
      const info: ClipInfo = {
        id: clipId,
        order,
        durationSec: round(probe.durationSec),
        fps: nominalFps(probe.fps),
        width: probe.width,
        height: probe.height,
        ...(scriptLineIndex !== undefined ? { scriptLineIndex } : {}),
        ...(takeNumber !== undefined ? { takeNumber } : {}),
      };
      return { info, normalizedPath, audioPath, thumbnailPath };
    },

    async buildConcatProxy({ clips, outPath }) {
      await mkdir(dirname(outPath), { recursive: true });
      const sorted = [...clips].sort((a, b) => a.info.order - b.info.order);
      const list = outPath + '.txt';
      await writeFile(list, sorted.map((c) => `file '${c.normalizedPath.replace(/'/g, "'\\''")}'`).join('\n'));
      try {
        await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', outPath]);
      } catch {
        await copyFile(sorted[0]!.normalizedPath, outPath);
      }
      return { path: outPath, clipOffsets: clipOffsets(sorted.map((c: IngestedClip) => c.info)) };
    },

    async ingestBroll({ assetId, inputPath, workDir, source, filename }) {
      const dir = join(workDir, assetId);
      await mkdir(dir, { recursive: true });
      const probe = await ffprobe(inputPath);
      if (!probe.width || !probe.height) throw new Error(`Not an image or video: ${inputPath}`);
      const ext = extname(inputPath).slice(1).toLowerCase() || 'bin';
      const isImage = ['jpg', 'jpeg', 'png', 'webp'].includes(ext) || probe.durationSec === 0 || probe.codec === 'mjpeg';
      const normalizedPath = join(dir, `normalized.${isImage ? (ext === 'png' ? 'png' : 'jpg') : 'mp4'}`);
      const thumbnailPath = join(dir, 'thumb.jpg');
      if (isImage && !['jpg', 'jpeg', 'png'].includes(ext)) await ffmpeg(['-i', inputPath, '-frames:v', '1', normalizedPath]);
      else await copyFile(inputPath, normalizedPath);
      await ffmpeg(['-i', inputPath, '-frames:v', '1', '-vf', 'scale=180:-2', thumbnailPath]);
      const name = (filename ?? inputPath).replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
      const asset: BrollAsset = {
        id: assetId,
        kind: isImage ? 'image' : 'video',
        ...(isImage ? {} : { durationSec: round(probe.durationSec) }),
        width: probe.width,
        height: probe.height,
        description: name || 'B-roll',
        source,
      };
      return { asset, normalizedPath, thumbnailPath };
    },

    async transcribeClip({ clipId, audioPath, durationSec }) {
      const sidecar = sidecarOf(audioPath);
      if (existsSync(sidecar)) {
        const t = Transcript.parse(JSON.parse(await readFile(sidecar, 'utf8')));
        return { ...t, clipId };
      }
      return { clipId, language: 'en', durationSec, words: [] };
    },

    async detectSilence({ clipId, audioPath }) {
      const sidecar = sidecarOf(audioPath);
      if (!existsSync(sidecar)) return [];
      const t = Transcript.parse(JSON.parse(await readFile(sidecar, 'utf8')));
      const gaps: SilenceGap[] = [];
      let last = 0;
      for (const w of t.words) {
        if (w.start - last > 0.3) gaps.push({ clipId, start: round(last), end: round(w.start) });
        last = Math.max(last, w.end);
      }
      if (t.durationSec - last > 0.3) gaps.push({ clipId, start: round(last), end: t.durationSec });
      return gaps;
    },

    async decideEdit(input) {
      return decide(input);
    },

    // Through `this.decideEdit`, so a test that replaces decideEdit on a copy of this object still decides.
    async decideEditWithNotices(this: AnalyzeApi, input: DecideInput) {
      const heard = input.transcripts.some((t) => t.words.length > 0);
      return { edl: await this.decideEdit(input), notices: heard ? [] : [{ code: 'no_speech', message: FAKE_NO_SPEECH_MESSAGE }] };
    },

    describeProviders() {
      return { standIns: ['transcriber', 'decider', 'describer', 'stock'], summary: 'fake pipeline (offline stand-ins for tests)' };
    },

    async replan(input) {
      const edl = input.edl;
      let overlays = [...edl.overlays];
      let variants = edl.variants;
      if (input.passes.includes('broll')) {
        overlays = overlays.filter((o) => o.type !== 'broll');
        if (edl.settings.broll) overlays.push(...placeBroll(edl.segments, input.broll));
      }
      if (input.passes.includes('graphics')) {
        overlays = overlays.filter((o) => o.type !== 'graphic');
        if (edl.settings.graphics) overlays.push(...placeGraphics(edl.segments));
      }
      if (input.passes.includes('variants')) variants = buildVariants(edl.segments, edl.settings.hookVariations);
      return { ...edl, overlays, variants };
    },

    async suggestStockBroll() {
      return options.stockCandidates ?? [];
    },
  };
}

export function createFakeTemplates(): TemplatesApi {
  return {
    async renderGraphic(req) {
      await mkdir(dirname(req.outPath), { recursive: true });
      await writeFile(req.outPath, `fake ${req.template} graphic`);
      return { path: req.outPath, hasAlpha: true };
    },
    async renderGraphicStill(req) {
      await mkdir(dirname(req.outPath), { recursive: true });
      await ffmpeg(['-f', 'lavfi', '-i', `color=c=white@0.0:s=54x96`, '-frames:v', '1', req.outPath]);
      return req.outPath;
    },
  };
}

/** Writes a tiny but real MP4 as long as the resolved timeline. */
export function createFakeRender(): RenderApi {
  return {
    async renderVideo(input) {
      const timeline = resolveTimeline(input.edl, input.variantId ?? null);
      for (const item of timeline.items) {
        if (!input.clips[item.segment.clipId]) throw new Error(`Render input is missing clip ${item.segment.clipId}`);
      }
      input.onProgress?.(0.05);
      for (const o of timeline.overlays) {
        if (o.overlay.type === 'broll' && !input.broll[o.overlay.assetId]) {
          throw new Error(`Render input is missing B-roll ${o.overlay.assetId}`);
        }
        if (o.overlay.type === 'graphic') {
          await input.renderGraphic({
            template: o.overlay.template,
            props: o.overlay.props,
            theme: getGraphicTheme(input.edl.settings.graphicThemeId),
            durationSec: o.outEnd - o.outStart,
            fps: input.edl.fps,
            width: input.edl.width,
            height: input.edl.height,
            outPath: join(input.workDir, `${o.overlay.id}.mov`),
          });
        }
      }
      input.onProgress?.(0.4);
      const duration = Math.max(0.2, timeline.durationSec);
      const [w, h, fps] = input.quality === 'final' ? [72, 128, 10] : [54, 96, 10];
      await mkdir(dirname(input.outPath), { recursive: true });
      await ffmpeg([
        '-f', 'lavfi', '-i', `color=c=0x1F5EFF:s=${w}x${h}:r=${fps}`,
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
        '-t', duration.toFixed(3),
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '32k', '-movflags', '+faststart', '-shortest',
        input.outPath,
      ]);
      input.onProgress?.(1);
      const probe = await ffprobe(input.outPath);
      return { outPath: input.outPath, durationSec: probe.durationSec, width: w, height: h, fps };
    },
  };
}

export function createFakePipeline(options: FakeOptions = {}): Pipeline {
  return { analyze: createFakeAnalyze(options), render: createFakeRender(), templates: createFakeTemplates() };
}
