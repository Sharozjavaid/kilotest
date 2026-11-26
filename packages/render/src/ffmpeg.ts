import { execFile, spawn } from 'node:child_process';

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
  /** Expected output duration in seconds, to turn ffmpeg's progress into 0..1. */
  durationSec?: number;
  onProgress?: (fraction: number) => void;
}

/**
 * Runs ffmpeg with an argument array (never a shell string). Progress comes from
 * `-progress pipe:1`. Resolves with stderr, which carries filter output such as
 * loudnorm's measurement.
 */
export function runFfmpeg(args: string[], opts: RunOptions = {}): Promise<string> {
  const full = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'info', '-nostats', '-progress', 'pipe:1', ...args];
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', full, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdoutBuf = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      // Keep memory bounded on very long renders.
      if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000);
    });
    child.stdout.on('data', (d: Buffer) => {
      stdoutBuf += d.toString();
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!opts.onProgress || !opts.durationSec) continue;
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m) {
          const sec = Number(m[1]) / 1e6;
          opts.onProgress(Math.max(0, Math.min(1, sec / opts.durationSec)));
        }
      }
    });
    child.on('error', (err) => reject(new FfmpegError(`Could not start ffmpeg: ${err.message}`, full, '')));
    child.on('close', (code) => {
      if (process.env.KILO_RENDER_DEBUG === '1') {
        const out = args[args.length - 1];
        process.stderr.write(`[render] ffmpeg ${((Date.now() - started) / 1000).toFixed(2)}s -> ${out}\n`);
      }
      if (code === 0) {
        opts.onProgress?.(1);
        resolve(stderr);
      } else {
        const tail = stderr.split('\n').filter(Boolean).slice(-15).join('\n');
        reject(new FfmpegError(`ffmpeg exited with code ${code}:\n${tail}`, full, stderr));
      }
    });
  });
}

export function execText(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${err.message}\n${stderr}`));
      else resolve(stdout);
    });
  });
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
  format: { duration?: string; bit_rate?: string; tags?: Record<string, string> };
}

export async function probe(path: string): Promise<ProbeResult> {
  const out = await execText('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path]);
  return JSON.parse(out) as ProbeResult;
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
