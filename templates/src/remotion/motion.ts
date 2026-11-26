/**
 * Time helpers and easing curves. Everything is a pure function of time in
 * seconds, so a frame renders the same at any frame rate and on any run.
 */

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, p: number): number => a + (b - a) * p;

let recording: number[] | null = null;

/**
 * Runs `fn` and returns every value `progress()` produced during it, in call order.
 * Every template reads time only through `progress()`, so two frames with the same
 * values draw the same pixels; the renderer uses this to capture a held frame once.
 */
export function recordProgress(fn: () => void): number[] {
  const prev = recording;
  const values: number[] = [];
  recording = values;
  try {
    fn();
  } finally {
    recording = prev;
  }
  return values;
}

/** Linear progress of `t` through the window [start, start + dur]. */
export function progress(t: number, start: number, dur: number): number {
  const p = dur <= 0 ? (t >= start ? 1 : 0) : clamp01((t - start) / dur);
  if (recording) recording.push(p);
  return p;
}

export const ease = {
  outCubic: (p: number) => 1 - Math.pow(1 - p, 3),
  outQuart: (p: number) => 1 - Math.pow(1 - p, 4),
  outQuint: (p: number) => 1 - Math.pow(1 - p, 5),
  outExpo: (p: number) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p)),
  inCubic: (p: number) => p * p * p,
  inQuart: (p: number) => p * p * p * p,
  inOutCubic: (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  inOutQuart: (p: number) => (p < 0.5 ? 8 * p * p * p * p : 1 - Math.pow(-2 * p + 2, 4) / 2),
  /** Overshoots then settles. `s` around 1.2 to 2.5. */
  outBack: (p: number, s = 1.70158) => {
    const c3 = s + 1;
    return 1 + c3 * Math.pow(p - 1, 3) + s * Math.pow(p - 1, 2);
  },
};

/**
 * The shared clock of a graphic. `k` compresses entrance and exit timings for
 * short durations, so a graphic at its minimum duration still gets a readable
 * hold instead of spending all its time animating.
 */
export interface Clock {
  t: number;
  /** Requested duration in seconds. */
  duration: number;
  /** Time of the last frame. Exits end exactly here, so the last frame is clear. */
  end: number;
  fps: number;
  k: number;
}

export function makeClock(frame: number, fps: number, durationSec: number, defaultDurationSec: number): Clock {
  const frames = Math.max(1, Math.round(durationSec * fps));
  const end = (frames - 1) / fps;
  const k = Math.min(1, Math.max(0.6, durationSec / defaultDurationSec));
  return { t: frame / fps, duration: durationSec, end, fps, k };
}

/** Progress of the exit (0 while held, 1 on the last frame). */
export function exitProgress(c: Clock, dur: number): number {
  const d = Math.min(dur * c.k, c.end * 0.3);
  return progress(c.t, c.end - d, d);
}
