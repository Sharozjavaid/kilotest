import { Platform } from 'react-native';

/**
 * Haptic feedback, in one vocabulary for the whole app:
 *
 * | Kind        | When                                                   | iOS                         | Android (no vibrator permission needed) |
 * |-------------|--------------------------------------------------------|-----------------------------|-----------------------------------------|
 * | `selection` | A value changed: segment, toggle, stepper, tab, chip   | `UISelectionFeedback`       | `CLOCK_TICK`                            |
 * | `light`     | A primary call to action committed; a line cut         | impact light                | `CONTEXT_CLICK`                         |
 * | `medium`    | Recording starts; the countdown says go                | impact medium               | `KEYBOARD_TAP`                          |
 * | `soft`      | Something undone gently (a cut line put back)          | impact soft                 | `CLOCK_TICK`                            |
 * | `rigid`     | Something snapped into place (a drag end)              | impact rigid                | `GESTURE_END`                           |
 * | `success`   | A long task finished: render done, batch started       | notification success        | `CONFIRM`                               |
 * | `warning`   | A destructive confirmation, a soft problem             | notification warning        | `REJECT`                                |
 * | `error`     | Something failed                                       | notification error          | `REJECT`                                |
 *
 * Which moment gets which kind is `motionHaptics` in `motionPresets.ts` (the design brief's
 * section 6): only primary calls to action tap on press; other presses are silent.
 *
 * Web gets nothing. Calls never throw and never wait: haptics are decoration.
 */
export type HapticKind = 'selection' | 'light' | 'medium' | 'soft' | 'rigid' | 'success' | 'warning' | 'error';

export type HapticCall =
  | { fn: 'selectionAsync' }
  | { fn: 'impactAsync'; arg: 'light' | 'medium' | 'soft' | 'rigid' }
  | { fn: 'notificationAsync'; arg: 'success' | 'warning' | 'error' }
  | { fn: 'performAndroidHapticsAsync'; arg: 'clock-tick' | 'context-click' | 'keyboard-tap' | 'gesture-end' | 'confirm' | 'reject' };

const IOS: Record<HapticKind, HapticCall> = {
  selection: { fn: 'selectionAsync' },
  light: { fn: 'impactAsync', arg: 'light' },
  medium: { fn: 'impactAsync', arg: 'medium' },
  soft: { fn: 'impactAsync', arg: 'soft' },
  rigid: { fn: 'impactAsync', arg: 'rigid' },
  success: { fn: 'notificationAsync', arg: 'success' },
  warning: { fn: 'notificationAsync', arg: 'warning' },
  error: { fn: 'notificationAsync', arg: 'error' },
};

// `View.performHapticFeedback` constants: tuned by the phone maker, and they need no VIBRATE
// permission. Ones a phone's Android version lacks do nothing.
const ANDROID: Record<HapticKind, HapticCall> = {
  selection: { fn: 'performAndroidHapticsAsync', arg: 'clock-tick' },
  light: { fn: 'performAndroidHapticsAsync', arg: 'context-click' },
  medium: { fn: 'performAndroidHapticsAsync', arg: 'keyboard-tap' },
  soft: { fn: 'performAndroidHapticsAsync', arg: 'clock-tick' },
  rigid: { fn: 'performAndroidHapticsAsync', arg: 'gesture-end' },
  success: { fn: 'performAndroidHapticsAsync', arg: 'confirm' },
  warning: { fn: 'performAndroidHapticsAsync', arg: 'reject' },
  error: { fn: 'performAndroidHapticsAsync', arg: 'reject' },
};

/** The native call for a kind on a platform, or null where there are no haptics (web). Pure. */
export function hapticCallFor(kind: HapticKind, os: typeof Platform.OS): HapticCall | null {
  if (os === 'ios') return IOS[kind];
  if (os === 'android') return ANDROID[kind];
  return null;
}

type HapticsModule = typeof import('expo-haptics');
let mod: HapticsModule | null | undefined;
let enabled = true;

function load(): HapticsModule | null {
  if (mod !== undefined) return mod;
  try {
    // Lazy, so web never loads the module.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('expo-haptics') as HapticsModule;
  } catch {
    mod = null;
  }
  return mod;
}

/** Plays a haptic. A no-op on web, when disabled, or when the module is missing. */
export function haptic(kind: HapticKind | false | undefined | null): void {
  if (!kind || !enabled) return;
  const call = hapticCallFor(kind, Platform.OS);
  if (!call) return;
  const h = load();
  if (!h) return;
  try {
    let p: Promise<void> | undefined;
    switch (call.fn) {
      case 'selectionAsync':
        p = h.selectionAsync();
        break;
      case 'impactAsync':
        p = h.impactAsync(call.arg as HapticsModule['ImpactFeedbackStyle'][keyof HapticsModule['ImpactFeedbackStyle']]);
        break;
      case 'notificationAsync':
        p = h.notificationAsync(call.arg as HapticsModule['NotificationFeedbackType'][keyof HapticsModule['NotificationFeedbackType']]);
        break;
      case 'performAndroidHapticsAsync':
        p = h.performAndroidHapticsAsync(call.arg as HapticsModule['AndroidHaptics'][keyof HapticsModule['AndroidHaptics']]);
        break;
    }
    p?.catch(() => undefined);
  } catch {
    // Haptics are decoration; never let them break a tap.
  }
}

/** Named helpers, for call sites that read better that way. */
export const haptics = {
  selection: () => haptic('selection'),
  light: () => haptic('light'),
  medium: () => haptic('medium'),
  soft: () => haptic('soft'),
  rigid: () => haptic('rigid'),
  success: () => haptic('success'),
  warning: () => haptic('warning'),
  error: () => haptic('error'),
};

/** Turns all haptics off (an in-app setting, or tests). */
export function setHapticsEnabled(on: boolean) {
  enabled = on;
}
