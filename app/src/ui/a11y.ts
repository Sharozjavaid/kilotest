import { useSyncExternalStore } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

/**
 * The two system settings the motion and glass primitives follow: Reduce Motion and (iOS)
 * Reduce Transparency. Read once at start, then kept current by one listener each, so a
 * press handler can ask `prefersReducedMotion()` at press time without a hook, and components
 * that render differently use the hooks below, which re-render only when a setting changes.
 */
interface A11yState {
  reduceMotion: boolean;
  reduceTransparency: boolean;
}

let state: A11yState = { reduceMotion: false, reduceTransparency: false };
const listeners = new Set<() => void>();
let started = false;

function set(patch: Partial<A11yState>) {
  const next = { ...state, ...patch };
  if (next.reduceMotion === state.reduceMotion && next.reduceTransparency === state.reduceTransparency) return;
  state = next;
  listeners.forEach((l) => l());
}

function start() {
  if (started) return;
  started = true;
  // Web: AccessibilityInfo maps Reduce Motion to `prefers-reduced-motion`.
  AccessibilityInfo.isReduceMotionEnabled?.()
    .then((v) => set({ reduceMotion: !!v }))
    .catch(() => undefined);
  AccessibilityInfo.addEventListener?.('reduceMotionChanged', (v: boolean) => set({ reduceMotion: !!v }));
  if (Platform.OS === 'ios') {
    AccessibilityInfo.isReduceTransparencyEnabled?.()
      .then((v) => set({ reduceTransparency: !!v }))
      .catch(() => undefined);
    AccessibilityInfo.addEventListener?.('reduceTransparencyChanged', (v: boolean) => set({ reduceTransparency: !!v }));
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

/** iOS Reduce Transparency as render state. Always false elsewhere. */
export function useReducedTransparency(): boolean {
  return useSyncExternalStore(subscribe, () => state.reduceTransparency, () => false);
}

/** For tests: force the settings. */
export function __setA11yForTests(patch: Partial<A11yState>) {
  started = true;
  set(patch);
}
