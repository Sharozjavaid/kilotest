import { useSyncExternalStore } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

/**
 * The system settings the motion, glass and theme primitives follow: Reduce Motion, Reduce
 * Transparency (iOS) and Increase Contrast (iOS "Increase Contrast", Android "High contrast
 * text"). Read once at start, then kept current by one listener each, so a press handler can
 * ask `prefersReducedMotion()` at press time without a hook, and components that render
 * differently use the hooks below, which re-render only when a setting changes.
 */
export interface A11yState {
  reduceMotion: boolean;
  reduceTransparency: boolean;
  increaseContrast: boolean;
}

let state: A11yState = { reduceMotion: false, reduceTransparency: false, increaseContrast: false };
const listeners = new Set<() => void>();
let started = false;

function set(patch: Partial<A11yState>) {
  const next = { ...state, ...patch };
  if (next.reduceMotion === state.reduceMotion && next.reduceTransparency === state.reduceTransparency && next.increaseContrast === state.increaseContrast) return;
  state = next;
  listeners.forEach((l) => l());
}

function watch(read: (() => Promise<boolean>) | undefined, event: string, key: keyof A11yState) {
  read?.call(AccessibilityInfo)
    .then((v) => set({ [key]: !!v }))
    .catch(() => undefined);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (AccessibilityInfo.addEventListener as any)?.(event, (v: boolean) => set({ [key]: !!v }));
  } catch {
    // Not supported on this platform.
  }
}

function start() {
  if (started) return;
  started = true;
  // Web: AccessibilityInfo maps Reduce Motion to `prefers-reduced-motion`.
  watch(AccessibilityInfo.isReduceMotionEnabled, 'reduceMotionChanged', 'reduceMotion');
  if (Platform.OS === 'ios') {
    watch(AccessibilityInfo.isReduceTransparencyEnabled, 'reduceTransparencyChanged', 'reduceTransparency');
    watch(AccessibilityInfo.isDarkerSystemColorsEnabled, 'darkerSystemColorsChanged', 'increaseContrast');
  } else if (Platform.OS === 'android') {
    watch(AccessibilityInfo.isHighTextContrastEnabled, 'highTextContrastChanged', 'increaseContrast');
  }
}

function subscribe(l: () => void) {
  start();
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Reduce Motion, right now. For event handlers (no re-render). */
export function prefersReducedMotion(): boolean {
  start();
  return state.reduceMotion;
}

/** Reduce Motion as render state: re-renders when the user changes it. */
export function useReducedMotionSetting(): boolean {
  return useSyncExternalStore(subscribe, () => state.reduceMotion, () => false);
}

/** Reduce Transparency as render state (iOS). Always false elsewhere. */
export function useReducedTransparency(): boolean {
  return useSyncExternalStore(subscribe, () => state.reduceTransparency, () => false);
}

/** Increase Contrast as render state. */
export function useIncreasedContrast(): boolean {
  return useSyncExternalStore(subscribe, () => state.increaseContrast, () => false);
}

/** For tests: force the settings. */
export function __setA11yForTests(patch: Partial<A11yState>) {
  started = true;
  set(patch);
}
