// Kept in step with packages/analyze/src/proc.ts (the packages are independent npm projects).
import { spawn, type ChildProcess } from 'node:child_process';
import { MediaStoppedError, MediaTimeoutError } from './errors.js';

/**
 * Child processes with a time limit, killed as a whole process group on timeout and
 * when this process is asked to stop.
 *
 * Every child is started in its own process group (`detached`), so a kill reaches
 * anything it started too. Because a detached child no longer receives the
 * terminal's Ctrl-C, one shared handler for SIGTERM and SIGINT kills every live child
 * first; if nothing else in the process listens for that signal it then re-raises
 * it, so the default behaviour (exit) is kept. The handler and the set of live
 * children are shared through `globalThis` by every Kilo package loaded in the
 * process (analyze, render, templates), so there is only ever one of each.
 */

interface Reaper {
  children: Set<ChildProcess>;
  /** Set once SIGTERM/SIGINT arrived: no new child is started after it. */
  stopping: string | null;
  track(child: ChildProcess): void;
}

const KEY = Symbol.for('kilo.childReaper.v1');

function killGroup(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

function createReaper(): Reaper {
  const children = new Set<ChildProcess>();
  const reaper: Reaper = {
    children,
    stopping: null,
    track(child) {
      children.add(child);
      child.once('exit', () => children.delete(child));
    },
  };
  const onSignal = (signal: NodeJS.Signals) => {
    reaper.stopping = signal;
    for (const c of children) killGroup(c);
    // When nobody else handles this signal, behave as if we had not been listening:
    // re-raise it. Libraries that clean up on the signal and then remove their own
    // listener (Remotion closing Chromium) get a moment to do so first; a listener
    // that stays (the host's own shutdown) means the host decides when to exit.
    const started = Date.now();
    const reraiseWhenAlone = () => {
      if (process.listenerCount(signal) === 1) {
        process.removeListener(signal, onSignal);
        process.kill(process.pid, signal);
      } else if (Date.now() - started < 15_000) {
        setTimeout(reraiseWhenAlone, 50).unref();
      }
    };
    reraiseWhenAlone();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  process.on('exit', () => {
    for (const c of children) killGroup(c);
  });
  return reaper;
}

export function reaper(): Reaper {
  const g = globalThis as unknown as Record<symbol, Reaper | undefined>;
  return (g[KEY] ??= createReaper());
}

/** Number of tracked children still running (for tests). */
export function liveChildren(): number {
  return reaper().children.size;
}

function envSec(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const v = Number(env[name]);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Default floor, seconds: even a tiny file may wait on a busy machine. */
export const TIMEOUT_FLOOR_SEC = 180;
/** Default allowance per second of media. */
export const TIMEOUT_PER_MEDIA_SEC = 10;

/**
 * Time limit for one ffmpeg/ffprobe run on `durationSec` of media: the larger of a
 * generous floor and a multiple of the duration. `KILO_MEDIA_TIMEOUT_SEC` replaces
 * the whole rule with a fixed limit; `KILO_MEDIA_TIMEOUT_FLOOR_SEC` and
 * `KILO_MEDIA_TIMEOUT_FACTOR` adjust its parts.
 */
export function mediaTimeoutMs(durationSec: number | undefined, env: NodeJS.ProcessEnv = process.env): number {
  const fixed = envSec(env, 'KILO_MEDIA_TIMEOUT_SEC');
  if (fixed !== undefined) return Math.round(fixed * 1000);
  const floor = envSec(env, 'KILO_MEDIA_TIMEOUT_FLOOR_SEC') ?? TIMEOUT_FLOOR_SEC;
  const factor = envSec(env, 'KILO_MEDIA_TIMEOUT_FACTOR') ?? TIMEOUT_PER_MEDIA_SEC;
  const d = durationSec !== undefined && Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  return Math.round(Math.max(floor, factor * d) * 1000);
}

export interface SpawnOptions {
  timeoutMs: number;
  cwd?: string;
  /** Cap on collected stdout, bytes. */
  maxBuffer?: number;
  /** Called with each stdout chunk instead of collecting it. */
  onStdout?: (chunk: Buffer) => void;
}

export interface SpawnResult {
  stdout: Buffer;
  stderr: string;
}

/** Thrown for a non-zero exit; carries stderr for the log. */
export class ChildFailedError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'ChildFailedError';
  }
}

/**
 * Runs `cmd` with an argument array (never a shell). Rejects with MediaTimeoutError
 * when the limit passes and MediaStoppedError when the process is told to stop; in
 * both cases the child's whole process group is killed first.
 */
export function spawnChecked(cmd: string, args: string[], opts: SpawnOptions): Promise<SpawnResult> {
  const r = reaper();
  if (r.stopping) return Promise.reject(new MediaStoppedError(`${cmd} not started: received ${r.stopping}`));
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    r.track(child);
    const out: Buffer[] = [];
    let outLen = 0;
    let stderr = '';
    let overflow = false;
    let timedOut = false;
    const max = opts.maxBuffer ?? 64 * 1024 * 1024;
    child.stdout!.on('data', (d: Buffer) => {
      if (opts.onStdout) return opts.onStdout(d);
      outLen += d.length;
      if (outLen > max) {
        overflow = true;
        killGroup(child);
        return;
      }
      out.push(d);
    });
    child.stderr!.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, opts.timeoutMs);
    timer.unref();
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new ChildFailedError(`Could not start ${cmd}: ${err.message}`, ''));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const tail = stderr.split('\n').filter(Boolean).slice(-12).join('\n');
      if (timedOut) {
        reject(new MediaTimeoutError(`${cmd} ran longer than ${(opts.timeoutMs / 1000).toFixed(0)} s and was killed`));
      } else if (r.stopping && code !== 0) {
        reject(new MediaStoppedError(`${cmd} killed: received ${r.stopping}`));
      } else if (overflow) {
        reject(new ChildFailedError(`${cmd} wrote more than ${max} bytes to stdout`, stderr));
      } else if (code !== 0) {
        reject(new ChildFailedError(`${cmd} failed (${signal ?? `exit code ${code}`})\n${tail}`, stderr));
      } else {
        resolve({ stdout: Buffer.concat(out), stderr });
      }
    });
  });
}
