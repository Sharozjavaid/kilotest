import { Platform } from 'react-native';

/**
 * How a glass surface is drawn on this device.
 *
 * - `liquid`: the system Liquid Glass (iOS 26 and later, `expo-glass-effect`).
 * - `blur`: a system blur under the translucent `surface` token (iOS before 26, web).
 * - `translucent`: the translucent `surface` token alone (Android, where a live blur costs a
 *   render pass per frame, and anywhere the blur is unavailable).
 * - `solid`: an opaque white surface (the user turned on Reduce Transparency).
 */
export type GlassMode = 'liquid' | 'blur' | 'translucent' | 'solid';

export interface GlassEnvironment {
  os: typeof Platform.OS;
  /** `isLiquidGlassAvailable() && isGlassEffectAPIAvailable()` on iOS, false elsewhere. */
  liquidGlass: boolean;
  /** iOS Reduce Transparency. */
  reduceTransparency: boolean;
}

/** Picks the glass rendering for a device. Pure: the inputs come from `glassEnvironment()`. */
export function glassModeFor(env: GlassEnvironment): GlassMode {
  if (env.os === 'ios') {
    // The system glass follows Reduce Transparency by itself (it turns frosted and opaque).
    if (env.liquidGlass) return 'liquid';
    return env.reduceTransparency ? 'solid' : 'blur';
  }
  if (env.os === 'web') return 'blur';
  return 'translucent';
}

let cachedLiquid: boolean | undefined;

/**
 * True when this build runs on iOS 26+ with the Liquid Glass API present. Checked once: the
 * native call is synchronous but there is no reason to repeat it. Some iOS 26 betas lack the
 * API (expo/expo#40911), hence both checks; any failure means "no".
 */
export function hasLiquidGlass(): boolean {
  if (cachedLiquid !== undefined) return cachedLiquid;
  cachedLiquid = false;
  if (Platform.OS !== 'ios') return cachedLiquid;
  try {
    // Required lazily so that web and Android never load the native module.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const glass = require('expo-glass-effect') as typeof import('expo-glass-effect');
    cachedLiquid = glass.isLiquidGlassAvailable() && glass.isGlassEffectAPIAvailable();
  } catch {
    cachedLiquid = false;
  }
  return cachedLiquid;
}

/** For tests. */
export function resetGlassCache() {
  cachedLiquid = undefined;
}
