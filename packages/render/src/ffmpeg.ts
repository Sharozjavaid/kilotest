import { ChildFailedError, mediaTimeoutMs, spawnChecked } from './proc.js';
import { ALL_CONTAINERS, assertProbedFormat, demuxArgs, inputArgs, safeInput, type Container, type SafeInput } from './safety.js';

/** Keep every ffmpeg to two threads: the machine is shared. */
export const THREADS = Number(process.env.KILO_RENDER_THREADS ?? 2) || 2;

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'FfmpegError';
  }
}

export interface RunOptions {
  cwd?: string;
  /** Expected output duration in seconds, to turn ffmpeg's progress into 0..1 and to set the time limit. */
  durationSec?: number;
  onProgress?: (fraction: number) => void;
  /** Explicit time limit, overriding the duration rule (mediaTimeoutMs). */
  timeoutMs?: number;
}

/**
 * Runs ffmpeg with an argument array (never a shell string). Progress comes from
 * `-progress pipe:1`. Resolves with stderr, which carries filter output such as
 * loudnorm's measurement. Time-limited by the media duration; killed with its
 * process group on timeout or when this process is told to stop (MediaTimeoutError,
 * MediaStoppedError).
 */
export async function runFfmpeg(args: string[], opts: RunOptions = {}): Promise<string> {
  const full = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'info', '-nostats', '-progress', 'pipe:1', ...args];
  const started = Date.now();
  let stdoutBuf = '';
  const onStdout = (d: Buffer) => {
    stdoutBuf += d.toString();
    let nl: number;
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!opts.onProgress || !opts.durationSec) continue;
      const m = /^out_time_us=(\d+)/.exec(line);
      if (m) opts.onProgress(Math.max(0, Math.min(1, Number(m[1]) / 1e6 / opts.durationSec)));
    }
  };
  try {
    const r = await spawnChecked(process.env.KILO_FFMPEG || 'ffmpeg', full, {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs ?? mediaTimeoutMs(opts.durationSec),
      onStdout,
    });
    opts.onProgress?.(1);
    return r.stderr;
  } catch (err) {
    if (err instanceof ChildFailedError) {
      const tail = err.stderr.split('\n').filter(Boolean).slice(-15).join('\n');
      throw new FfmpegError(`ffmpeg failed: ${err.message.split('\n')[0]}:\n${tail}`, full, err.stderr);
    }
    throw err;
  } finally {
    if (process.env.KILO_RENDER_DEBUG === '1') {
      process.stderr.write(`[render] ffmpeg ${((Date.now() - started) / 1000).toFixed(2)}s -> ${args[args.length - 1]}\n`);
    }
  }
}

export async function execText(cmd: string, args: string[], cwd?: string, timeoutMs?: number): Promise<string> {
  try {
    const r = await spawnChecked(cmd, args, { cwd, timeoutMs: timeoutMs ?? mediaTimeoutMs(undefined), maxBuffer: 256 * 1024 * 1024 });
    return r.stdout.toString('utf8');
  } catch (err) {
    if (err instanceof ChildFailedError) throw new Error(`${cmd} failed: ${err.message}\n${err.stderr}`);
    throw err;
  }
}

/** `-f <demuxer> ... -i file:<path>` for a file, after checking its content (see safety.ts). */
export async function fileInput(target: SafeInput | string, allowed: readonly Container[] = ALL_CONTAINERS): Promise<string[]> {
  return inputArgs(typeof target === 'string' ? await safeInput(target, allowed) : target);
}

/** Options for one of the renderer's own concat lists: local files of the expected format only. */
export function concatListInput(listPath: string, inner: 'wav' | 'mov'): string[] {
  return ['-protocol_whitelist', 'file', '-format_whitelist', `concat,${inner}`, '-f', 'concat', '-safe', '0', '-i', `file:${listPath}`];
}

export interface ProbeStream {
  codec_type: string;
  codec_name: string;
  profile?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  nb_frames?: string;
  duration?: string;
  bit_rate?: string;
}

export interface ProbeResult {
  streams: ProbeStream[];
  format: { duration?: string; bit_rate?: string; format_name?: string; tags?: Record<string, string> };
}

export async function probe(target: SafeInput | string): Promise<ProbeResult> {
  const input = typeof target === 'string' ? await safeInput(target, ALL_CONTAINERS) : target;
  const out = await execText(process.env.KILO_FFPROBE || 'ffprobe', [
    '-v', 'error', ...demuxArgs(input), '-show_streams', '-show_format', '-of', 'json', '-i', `file:${input.path}`,
  ]);
  const parsed = JSON.parse(out) as ProbeResult;
  assertProbedFormat(input, (parsed.format as { format_name?: string }).format_name);
  return parsed;
}

export function parseRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [n, d] = rate.split('/').map(Number);
  return d ? n! / d : n!;
}

/** Number formatting for filter graphs: fixed precision, no exponent. */
export function num(n: number, digits = 6): string {
  if (!Number.isFinite(n)) throw new Error(`Non-finite number in filter graph: ${n}`);
  const s = n.toFixed(digits);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}
