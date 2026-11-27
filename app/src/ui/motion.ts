import { Platform } from 'react-native';
import {
  FadeIn,
  FadeInDown,
  FadeOut,
  LinearTransition,
  ReduceMotion,
  withSequence,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { prefersReducedMotion, useReducedMotionSetting } from './a11y';
import { durations, isSpring, motionConfig, springs, type MotionName, type Spring, type Timing } from './motionPresets';

export * from './motionPresets';

/**
 * Motion built on the presets in `motionPresets.ts`. Everything here runs on the UI thread
 * (Reanimated): JS only starts an animation, it never drives frames.
 *
 * Web keeps the app's earlier, static behaviour: the layout animations below are `undefined`
 * there and the press motion is a plain opacity change (see `PressableScale.web.tsx`).
 */

const animated = Platform.OS !== 'web';

/** Starts the right animation for a config: a spring, a timing, or an instant jump. */
export function animateTo(target: number, config: Spring | Timing) {
  'worklet';
  if (isSpring(config)) return withSpring(target, { ...config, reduceMotion: ReduceMotion.Never });
  return withTiming(target, { duration: config.duration, reduceMotion: ReduceMotion.Never });
}

/**
 * Animates a shared value with a named motion, honouring Reduce Motion as it is right now.
 * For event handlers: `onPress={() => go(progress, 1, 'progress')}`.
 */
export function go(value: SharedValue<number>, target: number, name: MotionName) {
  value.value = animateTo(target, motionConfig(name, prefersReducedMotion()));
}

/** The success pop: up past full size and back. Reduce Motion: no change in size. */
export function pop(value: SharedValue<number>) {
  if (prefersReducedMotion()) {
    value.value = 1;
    return;
  }
  value.value = withSequence(withTiming(1.08, { duration: 90 }), withSpring(1, { ...springs.success, reduceMotion: ReduceMotion.Never }));
}

// ---- Layout animations ----------------------------------------------------------------------

function spring<T extends { stiffness(v: number): T; damping(v: number): T; mass(v: number): T }>(b: T, s: Spring): T {
  return b.stiffness(s.stiffness).damping(s.damping).mass(s.mass);
}

/**
 * `entering` / `exiting` / `layout` props for Animated views, by preset, under the current
 * Reduce Motion setting. Use the hook in components so they follow the setting live:
 *
 * ```tsx
 * const m = useLayoutMotion();
 * <Animated.View entering={m.appear} exiting={m.exit} layout={m.list}>…</Animated.View>
 * ```
 */
export function layoutMotion(reduceMotion: boolean) {
  if (!animated) return { appear: undefined, fadeIn: undefined, exit: undefined, list: undefined, appearAt: () => undefined };
  const rm = ReduceMotion.Never; // decided here, not by Reanimated's start-up snapshot
  // Builder methods mutate the builder, so every use that adds to one gets its own.
  const makeAppear = () =>
    reduceMotion
      ? FadeIn.duration(durations.fade).reduceMotion(rm)
      : spring(FadeInDown.springify(), springs.appear).withInitialValues({ opacity: 0, transform: [{ translateY: 8 }] }).reduceMotion(rm);
  const appear = makeAppear();
  return {
    /** Something new on screen: fades in and rises 8pt (Reduce Motion: fade only). */
    appear,
    /** A plain fade in. */
    fadeIn: FadeIn.duration(durations.fade).reduceMotion(rm),
    /** Leaving: a quick fade. */
    exit: FadeOut.duration(durations.exit).reduceMotion(rm),
    /** Siblings sliding to make room when a row is inserted or removed (Reduce Motion: none). */
    list: reduceMotion ? undefined : spring(LinearTransition.springify(), springs.list).reduceMotion(rm),
    /** `appear` for the n-th of several items arriving together (staggered, capped). */
    appearAt: (index: number) => makeAppear().delay(Math.min(index, 8) * (reduceMotion ? 0 : durations.stagger)),
  };
}

export type LayoutMotion = ReturnType<typeof layoutMotion>;

const cache = new Map<boolean, LayoutMotion>();

/** `layoutMotion` for the current Reduce Motion setting; stable between renders. */
export function useLayoutMotion(): LayoutMotion {
  const reduced = useReducedMotionSetting();
  let m = cache.get(reduced);
  if (!m) {
    m = layoutMotion(reduced);
    cache.set(reduced, m);
  }
  return m;
}
