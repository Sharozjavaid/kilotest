import { useCallback, useSyncExternalStore, type ReactNode } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, View } from 'react-native';
import Animated, { ReduceMotion, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Glass } from './Glass';
import { PressableScale } from './PressableScale';
import { SymbolIcon } from './SymbolIcon';
import { Text } from './type';
import { DEFAULT_SCREEN_APPEARANCE, ThemeScope, makeStyles, useColors } from './theme';
import { useLayoutMotion } from './motion';
import { motionHaptics, springs } from './motionPresets';
import { haptic, type HapticKind } from './haptics';
import type { IconName } from './Icon';

/**
 * Toasts (design brief 5.10): one glass capsule at a time, centred 12 above whatever floats at
 * the bottom of the screen, that says something happened and goes away by itself.
 *
 * ```ts
 * import { toast } from '@/ui';
 * toast.show({ text: 'Saved. You cut 1:49.', kind: 'success' });
 * toast.error("Couldn't save", { action: { label: 'Retry', onPress: retry } });
 * toast.show({ id: 'offline', kind: 'offline', text: "You're offline. Changes save when you're back." });
 * toast.hide('offline');
 * ```
 *
 * - One at a time: a new toast replaces the one showing (the old one leaves with `toastOut`, the
 *   new arrives with `toastIn`).
 * - Auto-dismiss after 2.4 s, errors after 4 s; `offline` stays until hidden. Tap or swipe down
 *   to dismiss.
 * - Haptics as the brief maps them: `error` plays the error haptic; `success` plays the success
 *   haptic only when asked (`haptic: true`: an export saved, a batch created); info none.
 * - Announced to VoiceOver (`announceForAccessibility`) and TalkBack / the web (live region).
 *
 * `ToastProvider` is mounted once in the root layout. A screen with chrome floating at the
 * bottom (a toolbar, a footer bar) calls `useToastInset(height)` so toasts sit above it.
 */

export type ToastKind = 'success' | 'info' | 'error' | 'offline';

export interface ToastInput {
  text: string;
  /** Default `info`. */
  kind?: ToastKind;
  /** A trailing text button (errors: "Retry"). The toast closes when it is pressed. */
  action?: { label: string; onPress: () => void };
  /**
   * Play the kind's haptic. Default: on for `error`, off for the rest. Pass true for a success
   * that ends a long task (export saved, batch created), as the brief asks.
   */
  haptic?: boolean;
  /** How long it stays, ms. Default 2400, errors 4000; `offline` (or 0) stays until hidden. */
  duration?: number;
  /** A stable id, to hide or replace this toast later (`toast.hide('offline')`). */
  id?: string;
}

export interface ToastItem {
  /** Unique per show; a new key is a new toast on screen (it animates in). */
  key: number;
  id: string;
  text: string;
  kind: ToastKind;
  action?: { label: string; onPress: () => void };
}

export const TOAST_DURATION_MS = 2400;
export const TOAST_ERROR_DURATION_MS = 4000;

/** How long a toast stays, ms; 0 for one that stays until hidden. Pure. */
export function toastDuration(input: Pick<ToastInput, 'kind' | 'duration'>): number {
  if (input.kind === 'offline') return 0;
  if (input.duration !== undefined) return Math.max(0, input.duration);
  return input.kind === 'error' ? TOAST_ERROR_DURATION_MS : TOAST_DURATION_MS;
}

/** The haptic a toast plays when it shows, or null. Pure. */
export function toastHaptic(input: Pick<ToastInput, 'kind' | 'haptic'>): HapticKind | null {
  const kind = input.kind ?? 'info';
  if (kind === 'error') return input.haptic === false ? null : motionHaptics.toastError;
  if (kind === 'success') return input.haptic ? motionHaptics.success : null;
  return null;
}

type Timer = { cancel: () => void };
type Schedule = (fn: () => void, ms: number) => Timer;

const realSchedule: Schedule = (fn, ms) => {
  const t = setTimeout(fn, ms);
  return { cancel: () => clearTimeout(t) };
};

/**
 * The toast queue (one slot: a new toast replaces the one showing). Exported for tests; the
 * app uses the `toast` singleton.
 */
export function createToastStore(opts: { schedule?: Schedule; onShow?: (item: ToastItem, input: ToastInput) => void } = {}) {
  const schedule = opts.schedule ?? realSchedule;
  let current: ToastItem | null = null;
  let timer: Timer | null = null;
  let seq = 0;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());

  function clearTimer() {
    timer?.cancel();
    timer = null;
  }

  function show(input: ToastInput): string {
    seq += 1;
    const item: ToastItem = { key: seq, id: input.id ?? `toast-${seq}`, text: input.text, kind: input.kind ?? 'info', action: input.action };
    clearTimer();
    current = item;
    const ms = toastDuration(input);
    if (ms > 0) timer = schedule(() => hide(item.id), ms);
    opts.onShow?.(item, input);
    emit();
    return item.id;
  }

  /** Hides the toast showing, or only the one with this id. */
  function hide(id?: string) {
    if (!current || (id !== undefined && current.id !== id)) return;
    clearTimer();
    current = null;
    emit();
  }

  return {
    show,
    hide,
    success: (text: string, o?: Omit<ToastInput, 'text' | 'kind'>) => show({ ...o, text, kind: 'success' }),
    info: (text: string, o?: Omit<ToastInput, 'text' | 'kind'>) => show({ ...o, text, kind: 'info' }),
    error: (text: string, o?: Omit<ToastInput, 'text' | 'kind'>) => show({ ...o, text, kind: 'error' }),
    current: () => current,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}

export type ToastStore = ReturnType<typeof createToastStore>;

function announce(item: ToastItem, input: ToastInput) {
  haptic(toastHaptic(input));
  // VoiceOver needs an announcement; TalkBack and the web read the live region on the toast.
  if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(item.text);
}

/** The app's toasts. */
export const toast = createToastStore({ onShow: announce });

// ---- Bottom inset: what floats at the bottom of the screen in front ----------------------------

const insets = new Map<number, number>();
let insetSeq = 0;
const insetListeners = new Set<() => void>();
const bottomInset = () => (insets.size ? Math.max(...insets.values()) : 0);

/**
 * Lifts toasts above chrome floating at the bottom of this screen (a glass toolbar, a footer
 * bar): pass its height from the screen's bottom edge, in points, home indicator included. Applies
 * while the screen is focused. Route screens only (it uses the navigation focus).
 */
export function useToastInset(height: number) {
  useFocusEffect(
    useCallback(() => {
      const id = ++insetSeq;
      insets.set(id, height);
      insetListeners.forEach((l) => l());
      return () => {
        insets.delete(id);
        insetListeners.forEach((l) => l());
      };
    }, [height]),
  );
}

function useBottomInset() {
  return useSyncExternalStore(
    (l) => {
      insetListeners.add(l);
      return () => insetListeners.delete(l);
    },
    bottomInset,
    bottomInset,
  );
}

// ---- View -------------------------------------------------------------------------------------

const ICON: Record<ToastKind, { name: IconName; tone: 'accent' | 'cut' } | null> = {
  success: { name: 'check', tone: 'accent' },
  info: null,
  error: { name: 'alert', tone: 'cut' },
  offline: { name: 'wifiOff', tone: 'cut' },
};

const useStyles = makeStyles(() => ({
  host: { ...StyleSheet.absoluteFill, justifyContent: 'flex-end', alignItems: 'center', paddingHorizontal: 16 },
  slot: { alignSelf: 'center', maxWidth: 340, width: '100%', alignItems: 'center' },
  capsule: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: 340 },
  text: { flexShrink: 1, fontSize: 14 },
  action: { minHeight: 44, marginVertical: -12, marginRight: -8, paddingHorizontal: 8, justifyContent: 'center' },
}));

/** Mount once, in the root layout, inside the safe-area and theme providers. */
export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <ThemeScope appearance={DEFAULT_SCREEN_APPEARANCE}>
        <ToastHost />
      </ThemeScope>
    </>
  );
}

function ToastHost() {
  const s = useStyles();
  const item = useSyncExternalStore(toast.subscribe, toast.current, toast.current);
  const safe = useSafeAreaInsets();
  const lifted = useBottomInset();
  const bottom = (lifted > 0 ? lifted : Math.max(safe.bottom, 12)) + 12;
  return (
    <View style={[s.host, { paddingBottom: bottom }]} pointerEvents="box-none">
      {item ? <ToastView key={item.key} item={item} /> : null}
    </View>
  );
}

const native = Platform.OS !== 'web';

function ToastView({ item }: { item: ToastItem }) {
  const s = useStyles();
  const c = useColors();
  const m = useLayoutMotion();
  const icon = ICON[item.kind];
  const dismiss = useCallback(() => toast.hide(item.id), [item.id]);

  const body = (
    <PressableScale
      onPress={dismiss}
      motion="chip"
      accessibilityRole={item.kind === 'error' ? 'alert' : 'button'}
      accessibilityLabel={item.text}
      accessibilityHint="Dismisses this message"
      accessibilityLiveRegion={item.kind === 'error' ? 'assertive' : 'polite'}
      testID="toast"
    >
      <Glass kind="toast" style={s.capsule}>
        {icon ? <SymbolIcon name={icon.name} size={16} strokeWidth={2.2} filled color={icon.tone === 'cut' ? c.cut : c.accent} /> : null}
        <Text variant="secondary" weight={500} numberOfLines={1} style={s.text}>
          {item.text}
        </Text>
        {item.action ? (
          <PressableScale
            onPress={() => {
              toast.hide(item.id);
              item.action!.onPress();
            }}
            motion="chip"
            accessibilityRole="button"
            accessibilityLabel={item.action.label}
            hitSlop={4}
            style={s.action}
            testID="toast-action"
          >
            <Text variant="secondary" weight={600} tone="accent" style={{ fontSize: 14 }}>
              {item.action.label}
            </Text>
          </PressableScale>
        ) : null}
      </Glass>
    </PressableScale>
  );

  return (
    <Animated.View entering={m.toastIn} exiting={m.toastOut} style={s.slot} pointerEvents="box-none">
      {native ? <Swipeable onDismiss={dismiss}>{body}</Swipeable> : body}
    </Animated.View>
  );
}

type GestureHandler = typeof import('react-native-gesture-handler');
let gestureHandler: GestureHandler | null = null;
/** Loaded on first use, so the design system loads under jest without the gesture handler's native setup. */
function gh(): GestureHandler {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  gestureHandler ??= require('react-native-gesture-handler') as GestureHandler;
  return gestureHandler;
}

/** Swipe down to dismiss, on the UI thread: the capsule follows the finger, then goes or springs back. */
function Swipeable({ onDismiss, children }: { onDismiss: () => void; children: ReactNode }) {
  const { GestureDetector, usePanGesture } = gh();
  const y = useSharedValue(0);
  const pan = usePanGesture({
    activeOffsetY: 6,
    failOffsetX: [-20, 20],
    onUpdate: (e) => {
      'worklet';
      // Down only; a little give upwards.
      y.value = e.translationY > 0 ? e.translationY : e.translationY / 6;
    },
    onDeactivate: (e) => {
      'worklet';
      if (e.translationY > 24 || e.velocityY > 500) {
        y.value = withTiming(80, { duration: 160, reduceMotion: ReduceMotion.System });
        runOnJS(onDismiss)();
      } else {
        y.value = withSpring(0, { ...springs.toast, reduceMotion: ReduceMotion.System });
      }
    },
  });
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }], opacity: 1 - Math.min(0.6, Math.max(0, y.value) / 120) }));
  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={style}>{children}</Animated.View>
    </GestureDetector>
  );
}
