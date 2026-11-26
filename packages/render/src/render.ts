import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CAPTION_HIGHLIGHT, getGraphicTheme, getTemplate, type RenderApi, type RenderInput, type RenderOutput } from '@kilo/edl';
import { buildAss, graphicRanges, groupCues, mapWords, subtractRanges } from './captions.js';
import { concatListInput, fileInput, probe, runFfmpeg } from './ffmpeg.js';
import { BROLL_CONTAINERS, CLIP_CONTAINERS, inputArgs, safeInput, type SafeInput } from './safety.js';
import { audioChunkArgs, AUDIO_RATE, encoderArgs, sampleBounds, videoChunkArgs } from './graph.js';
import { buildPlan, DEFAULT_LIMITS, RenderInputError, type ChunkLimits, type RenderPlan } from './plan.js';

export interface RenderOptions {
  /** Override chunking (tests use small limits to exercise the join). */
  limits?: ChunkLimits;
  /** Keep intermediates in workDir for debugging. Also KILO_RENDER_KEEP=1. */
  keepIntermediates?: boolean;
}

interface Loudness {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

const LOUDNORM = 'loudnorm=I=-14:TP=-1.5:LRA=11';

function concatList(files: string[]): string {
  return files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n';
}

function parseLoudnorm(stderr: string): Loudness | null {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(stderr.slice(start, end + 1)) as Loudness;
  } catch {
    return null;
  }
}

/** Splits 0..1 progress across stages by weight. */
class Progress {
  private done = 0;
  private last = -1;
  constructor(
    private readonly total: number,
    private readonly cb?: (p: number) => void,
  ) {}
  stage(weight: number): (f: number) => void {
    const base = this.done;
    this.done += weight;
    return (f: number) => this.emit((base + weight * Math.max(0, Math.min(1, f))) / this.total);
  }
  emit(p: number) {
    if (!this.cb) return;
    const v = Math.max(0, Math.min(1, p));
    if (v < this.last) return; // never go backwards
    this.last = v;
    this.cb(v);
  }
}

export async function renderVideo(input: RenderInput, options: RenderOptions = {}): Promise<RenderOutput> {
  const plan = buildPlan(input, options.limits ?? DEFAULT_LIMITS);
  const safe = await checkFiles(plan);
  await mkdir(input.workDir, { recursive: true });
  const tmp = await mkdtemp(join(resolve(input.workDir), 'kilo-render-'));
  const keep = options.keepIntermediates || process.env.KILO_RENDER_KEEP === '1';
  try {
    return await renderInto(plan, input, tmp, safe);
  } finally {
    if (!keep) await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Checks every input exists and is a plain media file of the expected kind, by
 * content (see safety.ts), and returns how to open each one.
 */
async function checkFiles(plan: RenderPlan): Promise<Map<string, SafeInput>> {
  const paths = new Map<string, { what: string; allowed: typeof CLIP_CONTAINERS }>();
  for (const it of plan.items) paths.set(it.clipPath, { what: `clip "${it.clipId}"`, allowed: CLIP_CONTAINERS });
  for (const o of plan.overlays) if (o.kind === 'broll') paths.set(o.path, { what: `B-roll asset "${o.asset.id}"`, allowed: BROLL_CONTAINERS });
  const safe = new Map<string, SafeInput>();
  for (const [p, { what, allowed }] of paths) {
    try {
      await access(p);
    } catch {
      throw new RenderInputError(`The file for ${what} does not exist: ${p}`);
    }
    safe.set(p, await safeInput(p, allowed));
  }
  return safe;
}

/** Where the time of the last render in this process went, in milliseconds (for timing reports). */
export const renderTimings: { last: { audioMs: number; graphicsMs: number; videoMs: number; muxMs: number; totalMs: number; chunks: number } | null } = {
  last: null,
};

async function renderInto(plan: RenderPlan, input: RenderInput, tmp: string, safe: Map<string, SafeInput>): Promise<RenderOutput> {
  const inputFor = (path: string): string[] => {
    const s = safe.get(path);
    if (!s) throw new Error(`Input was not checked before use: ${path}`);
    return inputArgs(s);
  };
  const t0 = performance.now();
  const mark = { audio: 0, graphics: 0, video: 0 };
  const { format: fmt } = plan;
  const F = fmt.fps;
  const edl = input.edl;
  const graphics = plan.overlays.filter((o) => o.kind === 'graphic');
  const weights = { audio: 0.06, graphics: graphics.length ? 0.12 : 0, video: 0.8, mux: 0.02 };
  const progress = new Progress(weights.audio + weights.graphics + weights.video + weights.mux, input.onProgress);
  progress.emit(0);

  // Clips without an audio stream get silence.
  const silentClips = new Set<string>();
  const seen = new Set<string>();
  for (const it of plan.items) {
    if (seen.has(it.clipId)) continue;
    seen.add(it.clipId);
    const p = await probe(safe.get(it.clipPath)!).catch((e: Error) => {
      throw new RenderInputError(`Clip "${it.clipId}" could not be read: ${e.message}`);
    });
    if (!p.streams.some((s) => s.codec_type === 'video')) {
      throw new RenderInputError(`Clip "${it.clipId}" has no video stream: ${it.clipPath}`);
    }
    if (!p.streams.some((s) => s.codec_type === 'audio')) silentClips.add(it.clipId);
  }

  // 1. Audio: chunks of exact sample length, measured, then normalised in one linear pass.
  const audioStage = progress.stage(weights.audio);
  const audioFiles: string[] = [];
  for (const chunk of plan.chunks) {
    const out = join(tmp, `audio_${chunk.index}.wav`);
    await runFfmpeg(audioChunkArgs({ fmt, input: inputFor, chunk, silentClips, outFile: out }), { cwd: tmp, durationSec: chunk.frames / F });
    audioFiles.push(out);
    audioStage(((chunk.index + 1) / plan.chunks.length) * 0.4);
  }
  const alist = join(tmp, 'audio.txt');
  await writeFile(alist, concatList(audioFiles));
  const totalSamples = sampleBounds(0, plan.totalFrames, F).count;
  const measure = await runFfmpeg([...concatListInput(alist, 'wav'), '-af', `${LOUDNORM}:print_format=json`, '-f', 'null', '-'], {
    cwd: tmp,
    durationSec: plan.durationSec,
    onProgress: (f) => audioStage(0.4 + 0.3 * f),
  });
  const m = parseLoudnorm(measure);
  const measuredI = m ? Number(m.input_i) : NaN;
  const norm =
    m && Number.isFinite(measuredI) && measuredI > -70
      ? `${LOUDNORM}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,`
      : '';
  const audioOut = join(tmp, 'audio.m4a');
  await runFfmpeg(
    [
      ...concatListInput(alist, 'wav'),
      '-af', `${norm}aresample=${AUDIO_RATE},asetpts=N/SR/TB,apad=whole_len=${totalSamples},atrim=end_sample=${totalSamples}`,
      '-c:a', 'aac', '-b:a', fmt.quality === 'final' ? '192k' : '128k', '-ar', String(AUDIO_RATE), '-ac', '2',
      audioOut,
    ],
    { cwd: tmp, durationSec: plan.durationSec, onProgress: (f) => audioStage(0.7 + 0.3 * f) },
  );

  mark.audio = performance.now();
  // 2. Graphics, at the output's real frame size and rate.
  if (graphics.length) {
    const gStage = progress.stage(weights.graphics);
    const theme = getGraphicTheme(edl.settings.graphicThemeId);
    let n = 0;
    for (const g of graphics) {
      if (g.kind !== 'graphic') continue;
      const outPath = join(tmp, `graphic_${n}.mov`);
      // Always ask within the template's range: a graphic cut short (by the end of the video or a
      // reordered variant) plays its normal timing and is trimmed, never squeezed.
      const spec = getTemplate(g.overlay.template);
      const durationSec = Math.min(spec.maxDurationSec, Math.max(spec.minDurationSec, g.frames / F));
      g.renderedFrames = Math.max(1, Math.round(durationSec * F));
      const res = await input.renderGraphic({
        template: g.overlay.template,
        props: g.overlay.props,
        theme,
        durationSec,
        fps: F,
        width: fmt.width,
        height: fmt.height,
        outPath,
      });
      g.path = res.path;
      try {
        await access(res.path);
      } catch {
        throw new Error(`renderGraphic for overlay "${g.overlay.id}" returned a file that does not exist: ${res.path}`);
      }
      safe.set(res.path, await safeInput(res.path, ['mov']));
      n += 1;
      gStage(n / graphics.length);
    }
  }

  mark.graphics = performance.now();
  // 3. Captions.
  let cues: ReturnType<typeof groupCues> = [];
  if (edl.captions.enabled) {
    const words = mapWords(plan.items, input.transcripts ?? [], F);
    cues = groupCues(words, edl.captions.style, plan.items);
  }
  const fullscreen = graphicRanges(plan.overlays, F, 'fullscreen');
  if (edl.captions.enabled && fullscreen.length) cues = cues.filter((c) => subtractRanges(c.start, c.end, fullscreen).length > 0);
  const assOpts = {
    style: edl.captions.style,
    width: fmt.width,
    height: fmt.height,
    highlight: CAPTION_HIGHLIGHT,
    lowerGraphics: graphicRanges(plan.overlays, F, 'lower'),
    upperGraphics: graphicRanges(plan.overlays, F, 'upper'),
    fullscreenGraphics: fullscreen,
  };

  // 4. Picture, chunk by chunk, encoded once with the final settings.
  const vStage = progress.stage(weights.video);
  const encoder = encoderArgs(fmt);
  const videoFiles: string[] = [];
  let framesDone = 0;
  for (const chunk of plan.chunks) {
    let assFile: string | undefined;
    if (edl.captions.enabled && cues.length) {
      const start = chunk.frameStart / F;
      const len = chunk.frames / F;
      const hasCue = cues.some((c) => c.end > start && c.start < start + len);
      if (hasCue) {
        assFile = `captions_${chunk.index}.ass`;
        await writeFile(join(tmp, assFile), buildAss(cues, assOpts, start, len));
      }
    }
    const out = join(tmp, `video_${chunk.index}.mp4`);
    const before = framesDone;
    await runFfmpeg(videoChunkArgs({ fmt, input: inputFor, chunk, assFile, encoder, outFile: out }), {
      cwd: tmp,
      durationSec: chunk.frames / F,
      onProgress: (f) => vStage((before + f * chunk.frames) / plan.totalFrames),
    });
    framesDone += chunk.frames;
    videoFiles.push(out);
  }

  mark.video = performance.now();
  // 5. Join and mux.
  const muxStage = progress.stage(weights.mux);
  const vlist = join(tmp, 'video.txt');
  await writeFile(vlist, concatList(videoFiles));
  await mkdir(resolve(input.outPath, '..'), { recursive: true });
  await runFfmpeg(
    [
      ...concatListInput(vlist, 'mov'),
      ...(await fileInput(audioOut, ['mov'])),
      '-map', '0:v:0', '-map', '1:a:0',
      '-c', 'copy',
      '-movflags', '+faststart',
      input.outPath,
    ],
    { cwd: tmp, durationSec: plan.durationSec, onProgress: muxStage },
  );
  progress.emit(1);
  const end = performance.now();
  renderTimings.last = {
    audioMs: mark.audio - t0,
    graphicsMs: mark.graphics - mark.audio,
    videoMs: mark.video - mark.graphics,
    muxMs: end - mark.video,
    totalMs: end - t0,
    chunks: plan.chunks.length,
  };
  return { outPath: input.outPath, durationSec: plan.durationSec, width: fmt.width, height: fmt.height, fps: F };
}

export const render: RenderApi = { renderVideo: (input) => renderVideo(input) };
