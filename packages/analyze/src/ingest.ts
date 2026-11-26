import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { BrollAsset, ClipInfo, ConcatProxy, IngestedBroll, IngestedClip } from '@kilo/edl';
import { OUTPUT_HEIGHT, OUTPUT_WIDTH, Transcript } from '@kilo/edl';
import { UnsupportedMediaError } from './errors.js';
import {
  FFPROBE,
  THREADS,
  durationOf,
  measureDurations,
  ffmpeg,
  fileInput,
  isStillImage,
  parseRate,
  probe,
  rotationOf,
  run,
  snapFps,
  type ProbeResult,
  type ProbeStream,
} from './ffmpeg.js';
import { BROLL_CONTAINERS, CLIP_CONTAINERS, demuxArgs, inputArgs, safeInput } from './safety.js';

const FIXTURE_PREFIX = 'kilo-words:';

export function sidecarPathFor(audioPath: string): string {
  return audioPath.replace(/\.wav$/i, '') + '.words.json';
}

/** The nominal rate of a video stream: r_frame_rate when it is sane, else the average rate. */
export function nominalFps(v: ProbeStream | undefined): { fps: number; variable: boolean } {
  const r = parseRate(v?.r_frame_rate);
  const avg = parseRate(v?.avg_frame_rate);
  const variable = r > 0 && avg > 0 && Math.abs(r - avg) > 0.01;
  const measured = r >= 20 && r <= 61 && (avg <= 0 || Math.abs(r - avg) < 2) ? r : avg > 0 ? avg : r;
  return { fps: snapFps(measured), variable };
}

function tagOf(tags: Record<string, string> | undefined, key: string): string | undefined {
  if (!tags) return undefined;
  const k = Object.keys(tags).find((t) => t.toLowerCase() === key);
  return k ? tags[k] : undefined;
}

/** Centre crop to 9:16, then scale to the output frame. Input dimensions are post-rotation. */
export const CROP_9x16 =
  "crop='trunc(min(iw,ih*9/16)/2)*2':'trunc(min(ih,iw*16/9)/2)*2'," +
  `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:flags=lanczos,setsar=1`;

/** Writes the fixture transcript sidecar when the source carries one (CONTRACTS.md section 4). */
export async function writeFixtureSidecar(p: ProbeResult, audioPath: string): Promise<boolean> {
  const comment = tagOf(p.format.tags, 'comment');
  if (!comment || !comment.startsWith(FIXTURE_PREFIX)) return false;
  const json = Buffer.from(comment.slice(FIXTURE_PREFIX.length), 'base64').toString('utf8');
  // The tag comes from the uploaded file: only a well-formed transcript is written.
  let parsed: Transcript;
  try {
    parsed = Transcript.parse(JSON.parse(json));
  } catch {
    return false;
  }
  await writeFile(sidecarPathFor(audioPath), JSON.stringify(parsed));
  return true;
}

export async function ingestClip(input: {
  clipId: string;
  order: number;
  inputPath: string;
  workDir: string;
  scriptLineIndex?: number;
  takeNumber?: number;
}): Promise<IngestedClip> {
  await mkdir(input.workDir, { recursive: true });
  // Content decides, never the name: only plain single-file video containers are opened.
  const source = await safeInput(input.inputPath, CLIP_CONTAINERS);
  const src = await probe(source);
  const video = src.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!video) throw new UnsupportedMediaError(`No video stream in ${input.inputPath}`);
  const audio = src.streams.find((s) => s.codec_type === 'audio');
  const { fps } = nominalFps(video);
  // The longer of picture and sound: speech after the last frame must survive (the
  // picture holds its last frame), and nothing is ever trimmed from the start.
  let videoDuration = durationOf(src, 'video') || durationOf(src);
  let audioDuration = audio ? Number(audio.duration) || 0 : 0;
  if (!(videoDuration > 0)) {
    // No duration in the container (browser MediaRecorder WebM): measure it from the packets.
    const measured = await measureDurations(source, src);
    videoDuration = measured.video;
    audioDuration = Math.max(audioDuration, measured.audio);
  }
  const sourceDuration = Math.max(videoDuration, audioDuration);
  if (!(sourceDuration > 0)) throw new Error(`Cannot read the duration of ${input.inputPath}`);

  const normalizedPath = join(input.workDir, 'normalized.mp4');
  const audioPath = join(input.workDir, 'audio.wav');
  const thumbnailPath = join(input.workDir, 'thumb.jpg');

  // Rotation: ffmpeg's autorotate (on by default) bakes the display matrix into the
  // pixels and drops it from the output, so the filter graph sees upright frames.
  // fps=N converts variable to constant frame rate by duplicating or dropping frames
  // against the source timestamps, so speech stays where the transcript says it is.
  // aresample async keeps audio on its timestamps (pads gaps, never shifts the start).
  const args = ['-threads', THREADS, ...inputArgs(source)];
  if (!audio) args.push('-f', 'lavfi', '-t', String(sourceDuration), '-i', 'anullsrc=r=48000:cl=stereo');
  args.push(
    '-map', '0:v:0',
    '-map', audio ? '0:a:0' : '1:a:0',
    '-vf', `${CROP_9x16},tpad=stop_mode=clone:stop_duration=${(sourceDuration - videoDuration + 0.5).toFixed(3)},fps=${fps},format=yuv420p`,
    '-af', 'aresample=48000:async=1000:first_pts=0,apad',
    '-t', sourceDuration.toFixed(6),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    // A keyframe at least every second: the renderer seeks into these files constantly.
    '-g', String(fps), '-force_key_frames', 'expr:gte(t,n_forced*1)',
    '-r', String(fps), '-fps_mode', 'cfr',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-map_metadata', '-1', '-movflags', '+faststart',
    normalizedPath,
  );
  await ffmpeg(args, sourceDuration);

  const norm = await probe(normalizedPath);
  const durationSec = durationOf(norm);
  await ffmpeg([
    '-threads', THREADS, ...(await fileInput(normalizedPath)), '-map', '0:a:0', '-af', 'apad', '-t', durationSec.toFixed(6),
    '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audioPath,
  ], durationSec);
  await writeThumbnail(normalizedPath, thumbnailPath, Math.min(0.5, durationSec / 2));
  await writeFixtureSidecar(src, audioPath);

  const info: ClipInfo = {
    id: input.clipId,
    order: input.order,
    durationSec,
    fps,
    width: OUTPUT_WIDTH,
    height: OUTPUT_HEIGHT,
    ...(input.scriptLineIndex !== undefined ? { scriptLineIndex: input.scriptLineIndex } : {}),
    ...(input.takeNumber !== undefined ? { takeNumber: input.takeNumber } : {}),
  };
  return { info, normalizedPath, audioPath, thumbnailPath };
}

export async function writeThumbnail(path: string, out: string, atSec: number): Promise<void> {
  await ffmpeg([
    '-threads', THREADS, '-ss', Math.max(0, atSec).toFixed(3), ...(await fileInput(path)), '-frames:v', '1',
    '-vf', 'scale=540:-2', '-q:v', '3', out,
  ]);
}

export const PROXY_AUDIO_RATE = 48000;

/**
 * Review proxy: 540x960, at most 30 fps, AAC, a keyframe every 0.5 s or less, +faststart.
 *
 * Each clip becomes a piece of a whole number of proxy frames (its duration rounded
 * up to the proxy rate), with its sound padded to exactly the same length, so picture
 * and sound of every clip start together. The pieces are joined without re-encoding
 * the picture, and `clipOffsets` are the running sums of the frames actually written
 * to each piece (counted with ffprobe), so they are exact over any number of clips.
 */
export async function buildConcatProxy(input: { clips: IngestedClip[]; outPath: string }): Promise<ConcatProxy> {
  if (input.clips.length === 0) throw new Error('buildConcatProxy needs at least one clip');
  await mkdir(dirname(input.outPath), { recursive: true });
  const clips = [...input.clips].sort((a, b) => a.info.order - b.info.order);
  const fps = Math.min(30, Math.max(...clips.map((c) => c.info.fps)));
  const samplesPerFrame = PROXY_AUDIO_RATE / fps;
  if (!Number.isInteger(samplesPerFrame)) throw new Error(`Proxy rate ${fps} does not divide ${PROXY_AUDIO_RATE} Hz`);
  const parts = join(dirname(input.outPath), `.proxy-parts-${randomBytes(4).toString('hex')}`);
  await mkdir(parts, { recursive: true });
  try {
    const vlist: string[] = [];
    const alist: string[] = [];
    const clipOffsets: Record<string, number> = {};
    let frames = 0;
    for (const [i, c] of clips.entries()) {
      const d = c.info.durationSec;
      const want = Math.max(1, Math.ceil(d * fps - 1e-6));
      const samples = want * samplesPerFrame;
      const v = join(parts, `v${i}.mp4`);
      const a = join(parts, `a${i}.wav`);
      await ffmpeg([
        '-threads', THREADS, ...(await fileInput(c.normalizedPath)),
        '-filter_complex',
        `[0:v:0]scale=540:960:flags=bicubic,setsar=1,fps=${fps},tpad=stop_mode=clone:stop_duration=1,` +
          `trim=end_frame=${want},setpts=N/(${fps}*TB),format=yuv420p[v];` +
          `[0:a:0]aresample=${PROXY_AUDIO_RATE},aformat=channel_layouts=stereo,apad=whole_len=${samples},` +
          `atrim=end_sample=${samples},asetpts=N/SR/TB[a]`,
        '-map', '[v]', '-an',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-r', String(fps), '-bf', '0',
        '-g', String(Math.max(1, Math.floor(fps / 2))), '-keyint_min', '1', '-sc_threshold', '0',
        '-force_key_frames', 'expr:gte(t,n_forced*0.5)', '-frames:v', String(want), '-map_metadata', '-1', v,
        '-map', '[a]', '-vn', '-c:a', 'pcm_s16le', '-ar', String(PROXY_AUDIO_RATE), '-ac', '2', a,
      ], d);
      const written = await countVideoFrames(v);
      const heard = await countAudioSamples(a);
      if (written !== want || heard !== samples) {
        throw new Error(`Proxy piece for clip ${c.info.id} has ${written} frames and ${heard} samples, expected ${want} and ${samples}`);
      }
      clipOffsets[c.info.id] = frames / fps;
      frames += written;
      vlist.push(`file '${basename(v)}'`);
      alist.push(`file '${basename(a)}'`);
    }
    const vl = join(parts, 'video.txt');
    const al = join(parts, 'audio.txt');
    await writeFile(vl, vlist.join('\n') + '\n');
    await writeFile(al, alist.join('\n') + '\n');
    // Our own lists of our own files; still only local files and the expected formats.
    const list = (formats: string, path: string) => ['-protocol_whitelist', 'file', '-format_whitelist', formats, '-f', 'concat', '-safe', '0', '-i', `file:${path}`];
    await ffmpeg([
      '-threads', THREADS, ...list('concat,mov', vl), ...list('concat,wav', al),
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '96k', '-ar', String(PROXY_AUDIO_RATE), '-ac', '2',
      '-movflags', '+faststart', input.outPath,
    ], frames / fps);
    return { path: input.outPath, clipOffsets };
  } finally {
    await rm(parts, { recursive: true, force: true });
  }
}

/** Frames in a file's first video stream, counted from its packets. */
export async function countVideoFrames(path: string): Promise<number> {
  const s = await safeInput(path, ['mov']);
  const { stdout } = await run(FFPROBE, [
    '-v', 'error', ...demuxArgs(s), '-select_streams', 'v:0', '-count_packets',
    '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', '-i', `file:${s.path}`,
  ]);
  return Number(stdout.trim());
}

/** Samples in a PCM WAV's first audio stream. */
async function countAudioSamples(path: string): Promise<number> {
  const s = await safeInput(path, ['wav']);
  const { stdout } = await run(FFPROBE, [
    '-v', 'error', ...demuxArgs(s), '-select_streams', 'a:0',
    '-show_entries', 'stream=duration_ts', '-of', 'csv=p=0', '-i', `file:${s.path}`,
  ]);
  return Number(stdout.trim());
}

export type BrollDescriber = (input: {
  kind: 'video' | 'image';
  normalizedPath: string;
  durationSec?: number;
  width: number;
  height: number;
  /** Dimensions of the original file, before normalising. */
  sourceWidth?: number;
  sourceHeight?: number;
  filename?: string;
  workDir: string;
}) => Promise<string>;

export async function ingestBroll(
  input: {
    assetId: string;
    inputPath: string;
    workDir: string;
    source: 'user' | 'stock';
    filename?: string;
  },
  describe: BrollDescriber,
): Promise<IngestedBroll> {
  await mkdir(input.workDir, { recursive: true });
  const source = await safeInput(input.inputPath, BROLL_CONTAINERS);
  const src = await probe(source);
  const v = src.streams.find((s) => s.codec_type === 'video');
  if (!v) throw new UnsupportedMediaError(`No picture in ${input.inputPath}`);
  const thumbnailPath = join(input.workDir, 'thumb.jpg');
  let asset: BrollAsset;
  let normalizedPath: string;
  if (source.container === 'jpeg' || source.container === 'png' || source.container === 'webp' || source.container === 'heif' || isStillImage(src)) {
    const ext = extname(input.filename ?? input.inputPath).toLowerCase() === '.png' ? '.png' : '.jpg';
    normalizedPath = join(input.workDir, `normalized${ext}`);
    await ffmpeg([
      '-threads', THREADS, ...inputArgs(source), '-frames:v', '1',
      '-vf', "scale='if(gte(iw,ih),min(2160,iw),-2)':'if(gte(iw,ih),-2,min(2160,ih))':flags=lanczos,setsar=1",
      ...(ext === '.jpg' ? ['-q:v', '2', '-pix_fmt', 'yuvj420p'] : []),
      normalizedPath,
    ]);
    await ffmpeg(['-threads', THREADS, ...(await fileInput(normalizedPath)), '-frames:v', '1', '-vf', 'scale=540:-2', '-q:v', '3', thumbnailPath]);
    const norm = await probe(normalizedPath);
    const nv = norm.streams.find((s) => s.codec_type === 'video');
    const width = nv?.width ?? 1;
    const height = nv?.height ?? 1;
    const description = await describe({ kind: 'image', normalizedPath, width, height, sourceWidth: v.width, sourceHeight: v.height, filename: input.filename ?? basename(input.inputPath), workDir: input.workDir });
    asset = { id: input.assetId, kind: 'image', width, height, description, source: input.source };
  } else {
    normalizedPath = join(input.workDir, 'normalized.mp4');
    const { fps } = nominalFps(v);
    const srcDuration = durationOf(src, 'video') || durationOf(src);
    await ffmpeg([
      '-threads', THREADS, ...inputArgs(source), '-map', '0:v:0', '-an',
      '-vf', `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase:flags=lanczos,crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},setsar=1,fps=${fps},format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-r', String(fps), '-fps_mode', 'cfr',
      '-g', String(fps), '-force_key_frames', 'expr:gte(t,n_forced*1)',
      '-map_metadata', '-1', '-movflags', '+faststart', normalizedPath,
    ], srcDuration);
    const norm = await probe(normalizedPath);
    const durationSec = durationOf(norm, 'video') || durationOf(norm);
    await writeThumbnail(normalizedPath, thumbnailPath, Math.min(0.5, durationSec / 2));
    const description = await describe({
      kind: 'video', normalizedPath, durationSec, width: OUTPUT_WIDTH, height: OUTPUT_HEIGHT,
      sourceWidth: v.width, sourceHeight: v.height,
      filename: input.filename ?? basename(input.inputPath), workDir: input.workDir,
    });
    asset = {
      id: input.assetId, kind: 'video', durationSec, width: OUTPUT_WIDTH, height: OUTPUT_HEIGHT,
      description, source: input.source,
    };
  }
  return { asset, normalizedPath, thumbnailPath };
}
