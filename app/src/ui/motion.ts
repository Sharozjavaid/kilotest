import { useEffect } from 'react';
import { Platform } from 'react-native';
import {
  Easing,
  LinearTransition,
  ReduceMotion,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
  type EntryExitAnimationFunction,
  type SharedValue,
} from 'react-native-reanimated';
import { prefersReducedMotion, useReducedMotionSetting } from './a11y';
import { distances, easings, isSpring, motionConfig, springs, staggerDelay, timings, type EasingName, type MotionName, type Spring, type Timing } from './motionPresets';

export * from './motionPresets';

/**
 * The motion set (`motionPresets.ts`, design brief section 6) as Reanimated animations. Every
 * frame runs on the UI thread: JS only starts an animation.
 *
 * Reduce Motion is decided here, from the live setting (`a11y.ts`): the reduced variants are
 * already safe (cross-fades, jumps), so they run with `ReduceMotion.Never`; the full variants
 * carry `ReduceMotion.System` as a backstop.
 *
 * Web keeps the app's earlier, static behaviour: the layout animations are `undefined` there
 * and presses are a plain opacity change (`PressableScale.web.tsx`).
 */

const animated = Platform.OS !== 'web';

const bezier = Object.fromEntries(
  (Object.keys(easings) as EasingName[]).map((k) => {
    const [x1, y1, x2, y2] = easings[k];
    return [k, Easing.bezier(x1, y1, x2, y2)];
  }),
) as Record<EasingName, ReturnType<typeof Easing.bezier>>;

/** Starts the right animation for a config: a spring, a timing, or an instant jump. */
export function animateTo(target: number, config: Spring | Timing, reduceMotion: ReduceMotion = ReduceMotion.System) {
  if (isSpring(config)) return withSpring(target, { ...config, reduceMotion });
  if (config.duration <= 0) return withTiming(target, { duration: 0, reduceMotion: ReduceMotion.Never });
  return withTiming(target, { duration: config.duration, easing: bezier[config.easing ?? 'standard'], reduceMotion });
}

/**
 * Animates a shared value with a named motion under the Reduce Motion setting as it is now.
 * For event handlers: `onPress={() => go(progress, 1, 'progress')}`.
 */
export function go(value: SharedValue<number>, target: number, name: MotionName) {
  const reduced = prefersReducedMotion();
  value.value = animateTo(target, motionConfig(name, reduced), reduced ? ReduceMotion.Never : ReduceMotion.System);
}

/**
 * A shared value that follows `target` with a named motion: `select` for a thumb or knob,
 * `progress` for a fill (which never runs backwards unless `allowBackwards`).
 *
 * ```tsx
 * const x = useMotionValue(selectedIndex, 'select');
 * const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.value * 80 }] }));
 * ```
 */
export function useMotionValue(target: number, name: MotionName, opts?: { allowBackwards?: boolean }) {
  const v = useSharedValue(target);
  const allowBackwards = opts?.allowBackwards ?? name !== 'progress';
  useEffect(() => {
    if (!allowBackwards && target < v.value) {
      // Progress never runs backwards: a lower value is shown at once (a new step began).
      v.value = target;
      return;
    }
    go(v, target, name);
  }, [target, name, allowBackwards, v]);
  return v;
}

/** `success` pop: 1 to 1.06 to 1 on a spring. Off under Reduce Motion. Returns the style and the trigger. */
export function usePop() {
  const s = useSharedValue(1);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: s.value }] }));
  const pop = () => {
    if (prefersReducedMotion()) return;
    s.value = withSequence(
      withTiming(distances.successPop, { duration: 90, easing: bezier.standard }),
      withSpring(1, { ...springs.success, reduceMotion: ReduceMotion.System }),
    );
  };
  return { style, pop };
}

/**
 * `shake`: translateX 0, -6, 6, -3, 0 over 240 ms, for a refused input. Off under Reduce Motion
 * (show an outline flash in `cut` instead: `shake()` returns false then).
 */
export function useShake() {
  const x = useSharedValue(0);
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const shake = (): boolean => {
    if (prefersReducedMotion()) return false;
    const steps = distances.shakeX.slice(1);
    const each = timings.shake.duration / steps.length;
    x.value = withSequence(...steps.map((to) => withTiming(to, { duration: each, easing: bezier.linear })));
    return true;
  };
  return { style, shake };
}

/**
 * `shimmer`: a 0..1 shared value looping every 1400 ms, linear, for the highlight band of a
 * skeleton. Static (0) under Reduce Motion.
 */
export function useShimmer(): SharedValue<number> {
  const t = useSharedValue(0);
  const reduced = useReducedMotionSetting();
  useEffect(() => {
    if (!animated || reduced) {
      cancelAnimation(t);
      t.value = 0;
      return;
    }
    t.value = 0;
    t.value = withRepeat(withTiming(1, { duration: timings.shimmer.duration, easing: Easing.linear, reduceMotion: ReduceMotion.System }), -1, false);
    return () => cancelAnimation(t);
  }, [reduced, t]);
  return t;
}

// ---- Layout animations ----------------------------------------------------------------------

type Entering = EntryExitAnimationFunction;

function fadeOnly(duration: number, from: number, to: number, easing: EasingName, delay = 0): Entering {
  const ease = bezier[easing];
  return () => {
    'worklet';
    return {
      initialValues: { opacity: from },
      animations: { opacity: withDelay(delay, withTiming(to, { duration, easing: ease, reduceMotion: ReduceMotion.Never })) },
    };
  };
}

function appear(delay: number): Entering {
  const ease = bezier.standard;
  const { duration } = timings.appear;
  const y = distances.appearY;
  return () => {
    'worklet';
    const t = { duration, easing: ease, reduceMotion: ReduceMotion.System };
    return {
      initialValues: { opacity: 0, transform: [{ translateY: y }] },
      animations: { opacity: withDelay(delay, withTiming(1, t)), transform: [{ translateY: withDelay(delay, withTiming(0, t)) }] },
    };
  };
}

function listInsert(): Entering {
  const s = springs.list;
  const from = distances.listScaleFrom;
  return () => {
    'worklet';
    const cfg = { ...s, reduceMotion: ReduceMotion.System };
    return {
      initialValues: { opacity: 0, transform: [{ scale: from }] },
      animations: { opacity: withSpring(1, cfg), transform: [{ scale: withSpring(1, cfg) }] },
    };
  };
}

function listRemove(): Entering {
  const ease = bezier.exit;
  const { duration } = timings.listRemove;
  const to = distances.listScaleFrom;
  return () => {
    'worklet';
    const t = { duration, easing: ease, reduceMotion: ReduceMotion.System };
    return {
      initialValues: { opacity: 1, transform: [{ scale: 1 }] },
      animations: { opacity: withTiming(0, t), transform: [{ scale: withTiming(to, t) }] },
    };
  };
}

function slideFade(fromY: number, spring: Spring): Entering {
  return () => {
    'worklet';
    const cfg = { ...spring, reduceMotion: ReduceMotion.System };
    return {
      initialValues: { opacity: 0, transform: [{ translateY: fromY }] },
      animations: { opacity: withSpring(1, cfg), transform: [{ translateY: withSpring(0, cfg) }] },
    };
  };
}

function toastOut(): Entering {
  const ease = bezier.exit;
  const { duration } = timings.toastOut;
  const y = distances.toastOutY;
  return () => {
    'worklet';
    const t = { duration, easing: ease, reduceMotion: ReduceMotion.System };
    return {
      initialValues: { opacity: 1, transform: [{ translateY: 0 }] },
      animations: { opacity: withTiming(0, t), transform: [{ translateY: withTiming(y, t) }] },
    };
  };
}

/**
 * `entering` / `exiting` / `layout` props for `Animated.View`, by motion, under a Reduce Motion
 * setting. Use `useLayoutMotion()` in components so they follow the setting live:
 *
 * ```tsx
 * const m = useLayoutMotion();
 * <Animated.View entering={m.listInsert} exiting={m.listRemove} layout={m.listLayout}>…</Animated.View>
 * {items.map((x, i) => <Animated.View key={x.id} entering={m.appearAt(i)}>…</Animated.View>)}
 * ```
 */
export function layoutMotion(reduceMotion: boolean) {
  if (!animated) {
    return {
      appear: undefined,
      appearAt: (_index: number) => undefined,
      listInsert: undefined,
      listRemove: undefined,
      listLayout: undefined,
      toastIn: undefined,
      toastOut: undefined,
      sheetIn: undefined,
    };
  }
  const fade = timings.reducedFade.duration;
  const appearAtCache = new Map<number, Entering>();
  return {
    /** `appear`: opacity 0 to 1, translateY 8 to 0, 240 ms standard. Reduce Motion: a 150 ms fade. */
    appear: reduceMotion ? fadeOnly(fade, 0, 1, 'standard') : appear(0),
    /** `appear` for the n-th of several items arriving together: 35 ms apart, first eight only. */
    appearAt: (index: number) => {
      const delay = staggerDelay(index, reduceMotion);
      let e = appearAtCache.get(delay);
      if (!e) {
        e = reduceMotion ? fadeOnly(fade, 0, 1, 'standard') : appear(delay);
        appearAtCache.set(delay, e);
      }
      return e;
    },
    /** `listInsert` entering: opacity 0 to 1, scale 0.97 to 1, on the list spring. */
    listInsert: reduceMotion ? fadeOnly(fade, 0, 1, 'standard') : listInsert(),
    /** `listRemove` exiting: opacity to 0 and scale 0.97, 160 ms exit. */
    listRemove: reduceMotion ? fadeOnly(fade, 1, 0, 'exit') : listRemove(),
    /** Siblings closing or opening the gap (`LinearTransition` on the list spring). None under Reduce Motion. */
    listLayout: reduceMotion
      ? undefined
      : LinearTransition.springify().mass(springs.list.mass).damping(springs.list.damping).stiffness(springs.list.stiffness).reduceMotion(ReduceMotion.System),
    /** `toast` in: translateY 20 to 0 and fade, on the toast spring. */
    toastIn: reduceMotion ? fadeOnly(fade, 0, 1, 'standard') : slideFade(distances.toastInY, springs.toast),
    /** `toast` out: fade and translateY 8, 180 ms exit. */
    toastOut: reduceMotion ? fadeOnly(fade, 1, 0, 'exit') : toastOut(),
    /** `sheetIn`: Kilo's own bottom panels (welcome): translateY 40 to 0 and fade. */
    sheetIn: reduceMotion ? fadeOnly(fade, 0, 1, 'standard') : slideFade(distances.sheetInY, springs.sheetIn),
  };
}

export type LayoutMotion = ReturnType<typeof layoutMotion>;

const cache = new Map<boolean, LayoutMotion>();

/** `layoutMotion` for the current Reduce Motion setting; the same objects between renders. */
export function useLayoutMotion(): LayoutMotion {
  const reduced = useReducedMotionSetting();
  let m = cache.get(reduced);
  if (!m) {
    m = layoutMotion(reduced);
    cache.set(reduced, m);
  }
  return m;
}
