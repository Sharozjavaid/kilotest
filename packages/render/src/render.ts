import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getGraphicTheme, type RenderApi, type RenderInput, type RenderOutput } from '@kilo/edl';
import { buildAss, graphicRanges, groupCues, mapWords } from './captions.js';
import { probe, runFfmpeg } from './ffmpeg.js';
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
  await checkFiles(plan);
  await mkdir(input.workDir, { recursive: true });
  const tmp = await mkdtemp(join(resolve(input.workDir), 'kilo-render-'));
  const keep = options.keepIntermediates || process.env.KILO_RENDER_KEEP === '1';
  try {
    return await renderInto(plan, input, tmp);
  } finally {
    if (!keep) await rm(tmp, { recursive: true, force: true });
  }
}

async function checkFiles(plan: RenderPlan): Promise<void> {
  const paths = new Map<string, string>();
  for (const it of plan.items) paths.set(it.clipPath, `clip "${it.clipId}"`);
  for (const o of plan.overlays) if (o.kind === 'broll') paths.set(o.path, `B-roll asset "${o.asset.id}"`);
  for (const [p, what] of paths) {
    try {
      await access(p);
    } catch {
      throw new RenderInputError(`The file for ${what} does not exist: ${p}`);
    }
  }
}

async function renderInto(plan: RenderPlan, input: RenderInput, tmp: string): Promise<RenderOutput> {
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
    const p = await probe(it.clipPath).catch((e: Error) => {
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
    await runFfmpeg(audioChunkArgs({ fmt, chunk, silentClips, outFile: out }), { cwd: tmp });
    audioFiles.push(out);
    audioStage(((chunk.index + 1) / plan.chunks.length) * 0.4);
  }
  const alist = join(tmp, 'audio.txt');
  await writeFile(alist, concatList(audioFiles));
  const totalSamples = sampleBounds(0, plan.totalFrames, F).count;
  const measure = await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', alist, '-af', `${LOUDNORM}:print_format=json`, '-f', 'null', '-'], {
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
      '-f', 'concat', '-safe', '0', '-i', alist,
      '-af', `${norm}aresample=${AUDIO_RATE},asetpts=N/SR/TB,apad=whole_len=${totalSamples},atrim=end_sample=${totalSamples}`,
      '-c:a', 'aac', '-b:a', fmt.quality === 'final' ? '192k' : '128k', '-ar', String(AUDIO_RATE), '-ac', '2',
      audioOut,
    ],
    { cwd: tmp, durationSec: plan.durationSec, onProgress: (f) => audioStage(0.7 + 0.3 * f) },
  );

  // 2. Graphics, at the output's real frame size and rate.
  if (graphics.length) {
    const gStage = progress.stage(weights.graphics);
    const theme = getGraphicTheme(edl.settings.graphicThemeId);
    let n = 0;
    for (const g of graphics) {
      if (g.kind !== 'graphic') continue;
      const outPath = join(tmp, `graphic_${n}.mov`);
      const res = await input.renderGraphic({
        template: g.overlay.template,
        props: g.overlay.props,
        theme,
        durationSec: g.frames / F,
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
      n += 1;
      gStage(n / graphics.length);
    }
  }

  // 3. Captions.
  let cues: ReturnType<typeof groupCues> = [];
  if (edl.captions.enabled) {
    const words = mapWords(plan.items, input.transcripts ?? [], F);
    cues = groupCues(words, edl.captions.style, plan.items);
  }
  const assOpts = {
    style: edl.captions.style,
    width: fmt.width,
    height: fmt.height,
    accent: getGraphicTheme(edl.settings.graphicThemeId).accent,
    lowerGraphics: graphicRanges(plan.overlays, F, 'lower'),
    upperGraphics: graphicRanges(plan.overlays, F, 'upper'),
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
    await runFfmpeg(videoChunkArgs({ fmt, chunk, assFile, encoder, outFile: out }), {
      cwd: tmp,
      durationSec: chunk.frames / F,
      onProgress: (f) => vStage((before + f * chunk.frames) / plan.totalFrames),
    });
    framesDone += chunk.frames;
    videoFiles.push(out);
  }

  // 5. Join and mux.
  const muxStage = progress.stage(weights.mux);
  const vlist = join(tmp, 'video.txt');
  await writeFile(vlist, concatList(videoFiles));
  await mkdir(resolve(input.outPath, '..'), { recursive: true });
  await runFfmpeg(
    [
      '-f', 'concat', '-safe', '0', '-i', vlist,
      '-i', audioOut,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c', 'copy',
      '-movflags', '+faststart',
      input.outPath,
    ],
    { cwd: tmp, durationSec: plan.durationSec, onProgress: muxStage },
  );
  progress.emit(1);
  return { outPath: input.outPath, durationSec: plan.durationSec, width: fmt.width, height: fmt.height, fps: F };
}

export const render: RenderApi = { renderVideo: (input) => renderVideo(input) };
