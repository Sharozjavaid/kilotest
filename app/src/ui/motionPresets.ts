/**
 * Every spring and duration in the app, in one place. Pure data (no Reanimated import) so
 * the choices can be tested; `motion.ts` turns them into Reanimated animations.
 *
 * Springs use stiffness/damping/mass (Reanimated 4 `withSpring`). As a guide: damping ratio
 * = damping / (2 * sqrt(stiffness * mass)); 1 settles without overshoot, lower bounces.
 */

export interface Spring {
  stiffness: number;
  damping: number;
  mass: number;
  /** Stop at the target instead of overshooting it. */
  overshootClamping?: boolean;
}

export interface Timing {
  duration: number;
}

/** Named springs. */
export const springs = {
  /** Finger down: quick, no bounce, so the control answers at once. */
  pressIn: { stiffness: 700, damping: 42, mass: 0.6, overshootClamping: true },
  /** Finger up: a little life on the way back. */
  pressOut: { stiffness: 420, damping: 20, mass: 0.6 },
  /** A selection moving: segment indicator, toggle knob, selected chip. */
  select: { stiffness: 520, damping: 34, mass: 0.8 },
  /** Things arriving on screen. */
  appear: { stiffness: 260, damping: 26, mass: 1 },
  /** Rows sliding to make room in a list. */
  list: { stiffness: 320, damping: 32, mass: 1 },
  /** A small pop when something succeeds (check mark, "Posted"). */
  success: { stiffness: 380, damping: 12, mass: 0.7 },
  /** Progress fills: settle without overshooting past the real value. */
  progress: { stiffness: 140, damping: 24, mass: 1, overshootClamping: true },
  /** Sheets and panels. */
  sheet: { stiffness: 300, damping: 30, mass: 1 },
} as const satisfies Record<string, Spring>;

export type SpringName = keyof typeof springs;

/** Durations for the few things that should not spring. */
export const durations = {
  /** Cross-fades and the Reduce Motion replacement for movement. */
  fade: 180,
  /** Leaving: faster than arriving. */
  exit: 140,
  /** Stagger between list items appearing together. */
  stagger: 30,
} as const;

/** How far a control shrinks under the finger, by kind. */
export const pressScales = {
  /** Primary and secondary pill buttons. */
  button: 0.96,
  /** Round icon buttons and chips: small things move more to be seen. */
  icon: 0.9,
  chip: 0.94,
  /** Cards: large, so a small change reads as a lot. */
  card: 0.98,
  /** List rows: barely, and mostly through opacity. */
  row: 0.985,
  /** Tiles on Home. */
  tile: 0.97,
} as const;

export type PressKind = keyof typeof pressScales;

/** Opacity while pressed, by kind. The values the components used before motion (web keeps only this). */
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
  /** Opacity while pressed. */
  opacity: number;
  pressIn: Spring | Timing;
  pressOut: Spring | Timing;
}

/**
 * What a press does for a kind of control. Under Reduce Motion nothing changes size: the
 * press shows as a quick opacity change only, which is not motion.
 */
export function pressMotion(kind: PressKind, reduceMotion: boolean): PressMotion {
  if (reduceMotion) {
    // Rows already read through opacity; others get a slightly stronger dim to make up for
    // the missing scale.
    const opacity = Math.min(pressOpacities[kind], 0.75);
    return { scale: 1, opacity, pressIn: { duration: 0 }, pressOut: { duration: durations.fade } };
  }
  return { scale: pressScales[kind], opacity: pressOpacities[kind], pressIn: springs.pressIn, pressOut: springs.pressOut };
}

export type MotionName = 'press' | 'select' | 'appear' | 'list' | 'success' | 'progress' | 'sheet';

/**
 * The animation config for a named motion: its spring, or under Reduce Motion a short
 * timing (fades) or none at all (movement jumps to the end).
 */
export function motionConfig(name: MotionName, reduceMotion: boolean): Spring | Timing {
  if (!reduceMotion) return name === 'press' ? springs.pressOut : springs[name];
  switch (name) {
    // Fades stay, shortened: they carry meaning (something arrived) without movement.
    case 'appear':
    case 'list':
      return { duration: durations.fade };
    // Progress still has to reach its value; it gets there without travelling.
    case 'progress':
    case 'press':
    case 'select':
    case 'success':
    case 'sheet':
      return { duration: 0 };
  }
}

export function isSpring(c: Spring | Timing): c is Spring {
  return 'stiffness' in c;
}
