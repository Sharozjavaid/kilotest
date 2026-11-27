import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NormalizedRequest } from './request.js';

/**
 * Held frames. Every template reads time only through `progress()` (see
 * src/remotion/motion.ts), so the list of values it returns while a frame is drawn
 * fully determines that frame's pixels. Drawing the templates in Node with a stub
 * text measurer gives that list for every frame in milliseconds; runs of frames
 * with the same list are static holds, captured once in Chromium and repeated.
 *
 * Text layout does not change the list: the number of progress() calls follows the
 * props (words, items), never measured widths. test/holds.test.ts checks that a
 * render with holds skipped is identical, frame for frame, to a full capture.
 */

/** Holds shorter than this are captured anyway: a separate capture pass costs about 10 frames. */
export function minSkipFrames(fps: number): number {
  return Math.max(12, Math.round(fps * 0.25));
}

export interface CapturePlan {
  /** Inclusive [first, last] frame ranges to capture in Chromium, in order. */
  ranges: Array<[number, number]>;
  /** For every frame, the frame whose picture it shows (itself when captured). */
  sourceOf: number[];
  captured: number;
}

export function fullPlan(frames: number): CapturePlan {
  return { ranges: [[0, frames - 1]], sourceOf: Array.from({ length: frames }, (_, i) => i), captured: frames };
}

/** Turns per-frame signatures into a capture plan. At most `maxRanges` capture passes. */
export function planFromSignatures(signatures: string[], fps: number, maxRanges = 4): CapturePlan {
  const frames = signatures.length;
  const runs: Array<[number, number]> = [];
  let a = 0;
  for (let i = 1; i <= frames; i++) {
    if (i === frames || signatures[i] !== signatures[a]) {
      // The last frame is always captured: the encoder repeats a held frame only up to the next one.
      const last = Math.min(i - 1, frames - 2);
      if (last - a + 1 >= minSkipFrames(fps)) runs.push([a, last]);
      a = i;
    }
  }
  // Keep the longest holds if there are too many to be worth a pass each.
  const kept = [...runs].sort((x, y) => y[1] - y[0] - (x[1] - x[0])).slice(0, maxRanges - 1).sort((x, y) => x[0] - y[0]);
  const sourceOf = Array.from({ length: frames }, (_, i) => i);
  const ranges: Array<[number, number]> = [];
  let start = 0;
  for (const [s, e] of kept) {
    for (let f = s + 1; f <= e; f++) sourceOf[f] = s;
    ranges.push([start, s]);
    start = e + 1;
  }
  if (start <= frames - 1) ranges.push([start, frames - 1]);
  const captured = ranges.reduce((n, [s, e]) => n + e - s + 1, 0);
  return { ranges, sourceOf, captured };
}

interface Modules {
  components: Record<string, unknown>;
  makeClock: (frame: number, fps: number, durationSec: number, defaultDurationSec: number) => unknown;
  recordProgress: (fn: () => void) => number[];
  safeArea: (height: number) => unknown;
  designWidth: number;
}

let modules: Promise<Modules> | null = null;

function loadModules(): Promise<Modules> {
  if (!modules) {
    modules = (async () => {
      const g = globalThis as { document?: unknown };
      if (g.document === undefined) {
        // fit.ts measures text on a canvas; any consistent widths do here (see above). The
        // stub answers with every metric fit.ts reads (advance and ink box, at the 200 px it
        // measures at), so no layout value comes out NaN: React warns about a NaN style.
        const measureText = (s: string) => ({
          width: s.length * 110,
          actualBoundingBoxAscent: 150,
          actualBoundingBoxDescent: 40,
          fontBoundingBoxAscent: 190,
          fontBoundingBoxDescent: 50,
        });
        g.document = {
          createElement: () => ({
            getContext: () => ({ font: '', letterSpacing: '', measureText }),
          }),
        };
      }
      const [graphic, motion, style] = await Promise.all([
        import('./remotion/Graphic.js'),
        import('./remotion/motion.js'),
        import('./remotion/style.js'),
      ]);
      return {
        components: graphic.COMPONENTS,
        makeClock: motion.makeClock,
        recordProgress: motion.recordProgress,
        safeArea: style.safeArea,
        designWidth: style.DESIGN_WIDTH,
      };
    })();
    modules.catch(() => {
      modules = null;
    });
  }
  return modules;
}

/** The progress() values of every frame, or null when the template cannot be drawn in Node. */
export async function frameSignatures(n: NormalizedRequest): Promise<string[] | null> {
  try {
    const m = await loadModules();
    const Component = m.components[n.template];
    if (!Component) return null;
    const designHeight = n.height / (n.width / m.designWidth);
    const area = m.safeArea(designHeight);
    const out: string[] = [];
    for (let f = 0; f < n.frames; f++) {
      const clock = m.makeClock(f, n.fps, n.durationSec, n.spec.defaultDurationSec);
      const values = m.recordProgress(() => {
        renderToStaticMarkup(createElement(Component as never, { props: n.props, theme: n.theme, clock, area } as never));
      });
      out.push(values.join(','));
    }
    return out;
  } catch {
    return null;
  }
}

/** The capture plan for a request: holds skipped unless KILO_TEMPLATES_SKIP_HOLDS=0. */
export async function capturePlan(n: NormalizedRequest): Promise<CapturePlan> {
  if (process.env.KILO_TEMPLATES_SKIP_HOLDS === '0' || n.frames < 2) return fullPlan(n.frames);
  const sigs = await frameSignatures(n);
  return sigs ? planFromSignatures(sigs, n.fps) : fullPlan(n.frames);
}
