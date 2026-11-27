import type { HapticKind } from './haptics';

/**
 * The motion set of `docs/design/ios-redesign.md` section 6: every spring, duration, easing and
 * haptic in the app, in one place. Pure data (no Reanimated import) so the choices can be
 * tested; `motion.ts` turns them into Reanimated animations and layout animations.
 *
 * Springs are Reanimated 4 `withSpring` configs (mass, damping, stiffness). Timings carry an
 * easing name from `easings` (cubic-bezier control points).
 */

export interface Spring {
  stiffness: number;
  damping: number;
  mass: number;
  /** Stop at the target instead of overshooting it. */
  overshootClamping?: boolean;
}

export type EasingName = keyof typeof easings;

export interface Timing {
  duration: number;
  easing?: EasingName;
}

/** Cubic-bezier control points. */
export const easings = {
  /** Most things arriving or changing. */
  standard: [0.2, 0.8, 0.2, 1],
  /** Things leaving. */
  exit: [0.4, 0, 1, 1],
  /** Progress fills and rings. */
  progress: [0.25, 0.1, 0.25, 1],
  linear: [0, 0, 1, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;

/** The springs of the motion set. */
export const springs = {
  /** `press`: scale down on press-in, back on release. */
  press: { mass: 0.5, damping: 18, stiffness: 420 },
  /** `select`: segment thumb, chip fill, toggle knob, scrub knob (settles in about 250 ms). */
  select: { mass: 0.8, damping: 22, stiffness: 320 },
  /** `listInsert` and the layout shift of `listRemove`. */
  list: { mass: 0.7, damping: 20, stiffness: 260 },
  /** `success`: the pop after the check draws. */
  success: { mass: 0.6, damping: 12, stiffness: 260 },
  /** `toast` in. */
  toast: { mass: 0.7, damping: 24, stiffness: 300 },
  /** `sheetIn`: Kilo's own bottom panels only (welcome). */
  sheetIn: { mass: 0.9, damping: 26, stiffness: 240 },
  /** `record`: the record button's inner circle to rounded square and back. */
  record: { mass: 0.6, damping: 16, stiffness: 300 },
} as const satisfies Record<string, Spring>;

/** Durations (ms) and distances (pt) of the timed motions. */
export const timings = {
  cutFill: { duration: 160, easing: 'standard' },
  cutStrike: { duration: 200, easing: 'standard' },
  numberRoll: { duration: 240, easing: 'standard' },
  appear: { duration: 240, easing: 'standard' },
  listRemove: { duration: 160, easing: 'exit' },
  progress: { duration: 450, easing: 'progress' },
  successCheck: { duration: 260, easing: 'standard' },
  toastOut: { duration: 180, easing: 'exit' },
  countdownIn: { duration: 300, easing: 'standard' },
  countdownOut: { duration: 200, easing: 'standard' },
  shimmer: { duration: 1400, easing: 'linear' },
  shake: { duration: 240, easing: 'linear' },
  /** What a moving or scaling motion becomes under Reduce Motion: a short cross-fade. */
  reducedFade: { duration: 150, easing: 'standard' },
} as const satisfies Record<string, Timing>;

export const distances = {
  appearY: 8,
  appearStagger: 35,
  /** Only the first eight items of a list stagger. */
  appearStaggerMax: 8,
  listScaleFrom: 0.97,
  successPop: 1.06,
  toastInY: 20,
  toastOutY: 8,
  sheetInY: 40,
  countdownFrom: 1.25,
  shimmerBand: 0.4,
  shimmerAlpha: 0.45,
  shakeX: [0, -6, 6, -3, 0] as readonly number[],
} as const;

/** How far a control shrinks under the finger, by kind. Buttons 0.97, cards and rows 0.98. */
export const pressScales = {
  button: 0.97,
  icon: 0.97,
  chip: 0.97,
  card: 0.98,
  row: 0.98,
  tile: 0.98,
} as const;

export type PressKind = keyof typeof pressScales;

/**
 * Opacity while pressed, by kind: what the controls showed before motion. Web keeps only
 * this; on native it is the Reduce Motion replacement for the scale.
 */
export const pressOpacities: Record<PressKind, number> = {
  button: 0.85,
  icon: 0.6,
  chip: 0.85,
  card: 0.85,
  row: 0.6,
  tile: 0.85,
};

export interface PressMotion {
  /** Scale while pressed (1 = none). */
  scale: number;
  /** Opacity while pressed (1 = none). */
  opacity: number;
  pressIn: Spring | Timing;
  pressOut: Spring | Timing;
}

/**
 * What a press does: a spring scale with no dimming; under Reduce Motion no change in size,
 * only a cross-fade of 150 ms to the old pressed opacity and back.
 */
export function pressMotion(kind: PressKind, reduceMotion: boolean): PressMotion {
  if (reduceMotion) {
    return { scale: 1, opacity: pressOpacities[kind], pressIn: { duration: 0 }, pressOut: timings.reducedFade };
  }
  return { scale: pressScales[kind], opacity: 1, pressIn: springs.press, pressOut: springs.press };
}

/** The 13 named custom motions (the 14th row of the spec, page and sheet transitions, is native). */
export type MotionName =
  | 'press'
  | 'select'
  | 'cutToggle'
  | 'appear'
  | 'listInsert'
  | 'listRemove'
  | 'progress'
  | 'success'
  | 'toast'
  | 'sheetIn'
  | 'record'
  | 'countdown'
  | 'shimmer'
  | 'shake';

/**
 * The animation config of a named motion. Under Reduce Motion: translate and scale motions
 * become cross-fades of 150 ms; progress and the record button jump to their value; stagger,
 * shimmer, pop and shake are off (`motionEnabled`).
 */
export function motionConfig(name: MotionName, reduceMotion: boolean): Spring | Timing {
  if (reduceMotion) {
    switch (name) {
      case 'progress':
      case 'record':
      case 'shimmer':
      case 'shake':
      case 'success':
        return { duration: 0 };
      case 'cutToggle':
        // A colour cross-fade, not movement: it stays as it is.
        return timings.cutFill;
      default:
        return timings.reducedFade;
    }
  }
  switch (name) {
    case 'press':
      return springs.press;
    case 'select':
      return springs.select;
    case 'cutToggle':
      return timings.cutFill;
    case 'appear':
      return timings.appear;
    case 'listInsert':
      return springs.list;
    case 'listRemove':
      return timings.listRemove;
    case 'progress':
      return timings.progress;
    case 'success':
      return springs.success;
    case 'toast':
      return springs.toast;
    case 'sheetIn':
      return springs.sheetIn;
    case 'record':
      return springs.record;
    case 'countdown':
      return timings.countdownIn;
    case 'shimmer':
      return timings.shimmer;
    case 'shake':
      return timings.shake;
  }
}

/** Motions that are switched off entirely under Reduce Motion (their state shows without them). */
export function motionEnabled(_name: 'stagger' | 'shimmer' | 'pop' | 'shake', reduceMotion: boolean): boolean {
  return !reduceMotion;
}

/** Delay for the n-th item of a list appearing together: 35 ms apart, first eight only, none under Reduce Motion. */
export function staggerDelay(index: number, reduceMotion: boolean): number {
  if (reduceMotion || index <= 0) return 0;
  return Math.min(index, distances.appearStaggerMax) * distances.appearStagger;
}

/** The haptic of each moment in the spec. Only these; never on scroll or press-in. */
export const motionHaptics = {
  /** A primary call to action committed (press released on it). Every other press: none. */
  primaryPress: 'light',
  /** A value changed in a Kilo-drawn control (native controls already play it). */
  select: 'selection',
  /** A line cut. */
  cut: 'light',
  /** A cut line put back. */
  restore: 'soft',
  /** A destructive delete, after the confirm. */
  remove: 'warning',
  /** A long task finished (export, batch created). */
  success: 'success',
  toastError: 'error',
  recordStart: 'medium',
  recordStop: 'light',
  countdownTick: 'selection',
  countdownGo: 'medium',
  /** The shake of a refused input. */
  shake: 'error',
} as const satisfies Record<string, HapticKind>;

export function isSpring(c: Spring | Timing): c is Spring {
  return 'stiffness' in c;
}
