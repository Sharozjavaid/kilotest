import { Platform } from 'react-native';

/**
 * The `<Glass>` fallback ladder (design brief section 7), as pure functions so it can be
 * tested. `Glass.ios.tsx` / `Glass.tsx` render what these decide.
 *
 * - `liquid`: the system Liquid Glass (iOS 26 and later, `expo-glass-effect`).
 * - `blur`: the system blur under a veil (iOS before 26).
 * - `css`: a CSS backdrop blur under a veil (web).
 * - `solid`: a solid surface with a hairline (Android, and everywhere under Reduce Transparency).
 */
export type GlassMode = 'liquid' | 'blur' | 'css' | 'solid';

export type GlassKind = 'bar' | 'button' | 'panel' | 'toast';

export interface GlassEnvironment {
  os: typeof Platform.OS;
  /** `isLiquidGlassAvailable() && isGlassEffectAPIAvailable()` on iOS, false elsewhere. */
  liquidGlass: boolean;
  reduceTransparency: boolean;
}

/** Picks the glass rendering for a device. */
export function glassModeFor(env: GlassEnvironment): GlassMode {
  if (env.reduceTransparency) return 'solid';
  if (env.os === 'ios') return env.liquidGlass ? 'liquid' : 'blur';
  if (env.os === 'web') return 'css';
  return 'solid';
}

/** Radius and padding by kind (section 5.1). Identical on every platform, so layouts never shift. */
export const glassKinds: Record<GlassKind, { radius: number; paddingVertical: number; paddingHorizontal: number }> = {
  bar: { radius: 28, paddingVertical: 8, paddingHorizontal: 8 },
  button: { radius: 22, paddingVertical: 0, paddingHorizontal: 0 },
  panel: { radius: 28, paddingVertical: 16, paddingHorizontal: 16 },
  toast: { radius: 22, paddingVertical: 12, paddingHorizontal: 16 },
};

export interface GlassFallback {
  backgroundColor: string;
  /** expo-blur tint (iOS before 26). */
  blurTint?: 'systemThinMaterialLight' | 'systemThinMaterialDark';
  /** CSS backdrop filter (web). */
  backdropFilter?: string;
  /** Draw the soft surface shadow (iOS blur, light only). */
  shadow: boolean;
  /** Android elevation. */
  elevation: number;
}

const CAMERA_SCRIM = '43,48,56'; // #2B3038

/** How a non-liquid glass surface is filled, per mode and appearance (section 7's table). */
export function glassFallback(mode: Exclude<GlassMode, 'liquid'>, scheme: 'light' | 'dark', os: typeof Platform.OS): GlassFallback {
  const dark = scheme === 'dark';
  switch (mode) {
    case 'blur':
      return dark
        ? { backgroundColor: `rgba(${CAMERA_SCRIM},0.35)`, blurTint: 'systemThinMaterialDark', shadow: false, elevation: 0 }
        : { backgroundColor: 'rgba(255,255,255,0.55)', blurTint: 'systemThinMaterialLight', shadow: true, elevation: 0 };
    case 'css':
      return dark
        ? { backgroundColor: `rgba(${CAMERA_SCRIM},0.75)`, backdropFilter: 'blur(20px) saturate(180%)', shadow: false, elevation: 0 }
        : { backgroundColor: 'rgba(255,255,255,0.72)', backdropFilter: 'blur(20px) saturate(180%)', shadow: false, elevation: 0 };
    case 'solid':
      return dark
        ? { backgroundColor: `rgba(${CAMERA_SCRIM},0.9)`, shadow: false, elevation: os === 'android' ? 2 : 0 }
        : { backgroundColor: 'rgba(255,255,255,0.94)', shadow: false, elevation: os === 'android' ? 2 : 0 };
  }
}

let cachedLiquid: boolean | undefined;

/**
 * True when this build runs on iOS 26+ with the Liquid Glass API present. Checked once. Some
 * iOS 26 betas lack the API (expo/expo#40911), hence both checks; any failure means "no".
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
