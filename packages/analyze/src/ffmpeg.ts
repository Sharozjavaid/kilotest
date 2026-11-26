import { ChildFailedError, mediaTimeoutMs, spawnChecked } from './proc.js';
import { ALL_CONTAINERS, assertProbedFormat, demuxArgs, inputArgs, safeInput, type Container, type SafeInput } from './safety.js';

/**
 * ffmpeg and ffprobe as child processes with argument arrays, never a shell. Every
 * run has a time limit scaled to the media it works on (see mediaTimeoutMs) and is
 * killed with its process group on timeout or when this process is told to stop.
 * Inputs are opened through `inputArgs` from safety.ts.
 */

export const FFMPEG = process.env.KILO_FFMPEG ?? 'ffmpeg';
export const FFPROBE = process.env.KILO_FFPROBE ?? 'ffprobe';
/** The machine is shared: keep every encode to two threads. */
export const THREADS = process.env.KILO_FFMPEG_THREADS ?? '2';

export interface RunResult {
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  maxBuffer?: number;
  /** Seconds of media the run reads or writes; sets the time limit. */
  durationSec?: number;
  /** Explicit limit, overriding the duration rule. */
  timeoutMs?: number;
}

export async function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  try {
    const r = await spawnChecked(cmd, args, {
      timeoutMs: opts.timeoutMs ?? mediaTimeoutMs(opts.durationSec),
      maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    });
    return { stdout: r.stdout.toString(), stderr: r.stderr };
  } catch (err) {
    if (err instanceof ChildFailedError) throw new Error(`${cmd} failed: ${err.message}`);
    throw err;
  }
}

export function ffmpeg(args: string[], durationSec?: number): Promise<RunResult> {
  return run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', ...args], { durationSec });
}

/** ffmpeg with info-level logging on stderr, for filters such as silencedetect that report there. */
export function ffmpegInfo(args: string[], durationSec?: number): Promise<RunResult> {
  return run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-loglevel', 'info', ...args], { durationSec });
}

export interface ProbeStream {
  index: number;
  codec_type: 'video' | 'audio' | 'subtitle' | 'data' | string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
  nb_frames?: string;
  sample_rate?: string;
  channels?: number;
  tags?: Record<string, string>;
  side_data_list?: Array<{ side_data_type?: string; rotation?: number }>;
  disposition?: Record<string, number>;
}

export interface ProbeResult {
  streams: ProbeStream[];
  format: { duration?: string; format_name?: string; tags?: Record<string, string> };
}

/**
 * Probes a file opened with exactly the demuxer its content calls for (see
 * safety.ts), and checks that demuxer is what opened it.
 */
export async function probe(target: SafeInput | string): Promise<ProbeResult> {
  const input = typeof target === 'string' ? await safeInput(target, ALL_CONTAINERS) : target;
  const { stdout } = await run(FFPROBE, [
    '-v', 'error', ...demuxArgs(input), '-show_format', '-show_streams', '-of', 'json', '-i', `file:${input.path}`,
  ]);
  const parsed = JSON.parse(stdout) as Partial<ProbeResult>;
  const result = { streams: parsed.streams ?? [], format: parsed.format ?? {} };
  assertProbedFormat(input, result.format.format_name);
  return result;
}

/** `-f <demuxer> ... -i file:<path>` for one of the pipeline's own files (or a checked SafeInput). */
export async function fileInput(target: SafeInput | string, allowed: readonly Container[] = ALL_CONTAINERS): Promise<string[]> {
  return inputArgs(typeof target === 'string' ? await safeInput(target, allowed) : target);
}

export function parseRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [n, d] = rate.split('/').map(Number);
  if (!n || !Number.isFinite(n)) return 0;
  if (d === undefined) return n;
  if (!d) return 0;
  return n / d;
}

export const NOMINAL_RATES = [24, 25, 30, 50, 60] as const;

/** Snaps a measured rate (29.97, 59.94, 23.976, 48, 120...) to the nearest nominal rate. */
export function snapFps(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return 30;
  if (rate > 60) return 60;
  let best: number = NOMINAL_RATES[0];
  for (const r of NOMINAL_RATES) if (Math.abs(r - rate) < Math.abs(best - rate)) best = r;
  return best;
}

/** Rotation in degrees from the display matrix or the legacy rotate tag. */
export function rotationOf(stream: ProbeStream): number {
  const side = stream.side_data_list?.find((s) => typeof s.rotation === 'number');
  const raw = side?.rotation ?? (stream.tags?.rotate !== undefined ? Number(stream.tags.rotate) : 0);
  const r = ((Math.round(raw) % 360) + 360) % 360;
  return r;
}

export function durationOf(p: ProbeResult, kind?: 'video' | 'audio'): number {
  if (kind) {
    const s = p.streams.find((x) => x.codec_type === kind);
    const d = Number(s?.duration);
    if (Number.isFinite(d) && d > 0) return d;
  }
  const f = Number(p.format.duration);
  return Number.isFinite(f) ? f : 0;
}

/**
 * Duration per stream kind measured from the packets, for files whose container states
 * none: a browser's MediaRecorder writes WebM with no duration in the header (and a
 * variable frame rate). The end of the last packet of each kind, in seconds.
 */
export async function measureDurations(target: SafeInput, p: ProbeResult): Promise<{ video: number; audio: number }> {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error', ...demuxArgs(target), '-show_entries', 'packet=stream_index,pts_time,duration_time', '-of', 'csv=p=0', '-i', `file:${target.path}`,
  ]);
  const kindOf = new Map(p.streams.map((s) => [s.index, s.codec_type]));
  const out = { video: 0, audio: 0 };
  for (const line of stdout.split('\n')) {
    const [idx, pts, dur] = line.split(',');
    const kind = kindOf.get(Number(idx));
    const end = Number(pts) + (Number(dur) || 0);
    if ((kind === 'video' || kind === 'audio') && Number.isFinite(end)) out[kind] = Math.max(out[kind], end);
  }
  return out;
}

const IMAGE_CODECS = new Set(['png', 'mjpeg', 'jpeg', 'webp', 'bmp', 'gif', 'tiff', 'heic', 'hevc_image', 'jpegxl', 'av1_image']);

/** True when the probed file is a still image rather than a video. */
export function isStillImage(p: ProbeResult): boolean {
  const v = p.streams.find((s) => s.codec_type === 'video');
  if (!v) return false;
  const fmt = p.format.format_name ?? '';
  if (/image2|_pipe|png|jpeg|webp/.test(fmt) && !/mov|mp4|matroska|webm|avi/.test(fmt)) return true;
  if (v.disposition?.attached_pic) return true;
  const frames = Number(v.nb_frames);
  if (IMAGE_CODECS.has(v.codec_name ?? '') && (!Number.isFinite(frames) || frames <= 1)) return true;
  return false;
}
