import { createContext, useContext, type ReactNode } from 'react';
import { StyleSheet, useColorScheme } from 'react-native';
import { useIncreasedContrast } from './a11y';
import { darkColors, lightColors, type Palette } from './tokens';

/**
 * Light and dark themes. A theme is one of four frozen objects (light or dark, with or without
 * Increase Contrast), so a context holding one changes only when the appearance or the setting
 * changes: components that read it re-render then and at no other time, and `makeStyles`
 * builds each StyleSheet at most once per theme.
 *
 * - `ThemeProvider` (root layout) follows the system appearance.
 * - `ThemeScope` sets the appearance of a subtree: `auto` (follow the system), `light` or
 *   `dark`. `Screen` opens one from its `appearance` prop; the recorder is `dark` always.
 * - `useTheme()` / `useColors()` read it; `makeStyles(t => ({…}))` makes a hook that returns
 *   theme-aware styles.
 *
 * The plain `color`, `shadow`, `accentGloss` and `groundGradient` exports stay as the light
 * values, so code that has not moved to the theme keeps rendering light.
 */

export type Scheme = 'light' | 'dark';
export type Appearance = 'auto' | Scheme;

export interface Theme {
  scheme: Scheme;
  highContrast: boolean;
  color: Palette;
  groundGradient: { colors: readonly [string, string, string]; locations: readonly [number, number, number] };
  accentGloss: { colors: readonly [string, string]; locations: readonly [number, number] };
  /** Shadows (none in dark: borders carry the edges there). */
  shadow: {
    surface: { boxShadow?: string };
    gloss: { boxShadow?: string };
    player: { boxShadow?: string };
    selected: { boxShadow?: string };
  };
  /** The status bar text style that reads on this theme's ground. */
  statusBar: 'dark' | 'light';
}

/**
 * Appearance of a `Screen` that does not set one. `light` while screens move to the theme: a
 * screen not yet converted still has light-only colours in its own styles, so it stays light
 * even in dark mode. Set to `auto` once every screen reads its colours from the theme.
 */
export const DEFAULT_SCREEN_APPEARANCE: Appearance = 'light';

function build(scheme: Scheme, highContrast: boolean): Theme {
  const base = scheme === 'dark' ? darkColors : lightColors;
  // Increase Contrast: muted text becomes ink at 80%; hairlines become outlines.
  const color: Palette = highContrast
    ? { ...base, muted: scheme === 'dark' ? 'rgba(242,245,250,0.8)' : 'rgba(11,18,32,0.8)', hairline: base.outline }
    : base;
  const dark = scheme === 'dark';
  return Object.freeze({
    scheme,
    highContrast,
    color: Object.freeze(color),
    groundGradient: { colors: [color.skyTint, color.ground, color.ground] as const, locations: [0, 0.36, 1] as const },
    accentGloss: { colors: [color.glossTop, color.glossBottom] as const, locations: [0, 1] as const },
    shadow: dark
      ? { surface: {}, gloss: {}, player: {}, selected: {} }
      : {
          surface: { boxShadow: '0 8px 24px rgba(31,94,255,0.08)' },
          gloss: { boxShadow: '0 8px 20px rgba(31,94,255,0.28), inset 0 1px 0 rgba(255,255,255,0.35)' },
          player: { boxShadow: '0 12px 28px rgba(31,94,255,0.18)' },
          selected: { boxShadow: '0 8px 20px rgba(31,94,255,0.2)' },
        },
    statusBar: dark ? 'light' : 'dark',
  });
}

export const themes = {
  light: build('light', false),
  dark: build('dark', false),
  lightContrast: build('light', true),
  darkContrast: build('dark', true),
} as const;

/** The theme object for a scheme and contrast setting (one of the four frozen themes). */
export function themeFor(scheme: Scheme, highContrast = false): Theme {
  if (scheme === 'dark') return highContrast ? themes.darkContrast : themes.dark;
  return highContrast ? themes.lightContrast : themes.light;
}

/** What a scope with `appearance` resolves to, given the system scheme. Pure. */
export function resolveScheme(appearance: Appearance, system: Scheme | null | undefined): Scheme {
  if (appearance === 'auto') return system === 'dark' ? 'dark' : 'light';
  return appearance;
}

interface ThemeCtx {
  theme: Theme;
  /** The system's scheme, for nested `auto` scopes. */
  system: Scheme;
}

const Ctx = createContext<ThemeCtx>({ theme: themes.light, system: 'light' });

/** Root: follows the system appearance and Increase Contrast. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const scheme = useColorScheme();
  const contrast = useIncreasedContrast();
  const system: Scheme = scheme === 'dark' ? 'dark' : 'light';
  return <Ctx.Provider value={ctxFor(system, system, contrast)}>{children}</Ctx.Provider>;
}

/** Sets the appearance of a subtree. */
export function ThemeScope({ appearance, children }: { appearance: Appearance; children: ReactNode }) {
  const parent = useContext(Ctx);
  const scheme = resolveScheme(appearance, parent.system);
  return <Ctx.Provider value={ctxFor(scheme, parent.system, parent.theme.highContrast)}>{children}</Ctx.Provider>;
}

// Context values are cached too, so a provider re-rendering for another reason does not
// hand its consumers a new object.
const ctxCache = new Map<string, ThemeCtx>();
function ctxFor(scheme: Scheme, system: Scheme, contrast: boolean): ThemeCtx {
  const key = `${scheme}|${system}|${contrast ? 1 : 0}`;
  let v = ctxCache.get(key);
  if (!v) {
    v = { theme: themeFor(scheme, contrast), system };
    ctxCache.set(key, v);
  }
  return v;
}

export function useTheme(): Theme {
  return useContext(Ctx).theme;
}

export function useColors(): Palette {
  return useContext(Ctx).theme.color;
}

/** The system scheme (what `auto` resolves to), whatever the current scope says. */
export function useSystemScheme(): Scheme {
  return useContext(Ctx).system;
}

/**
 * Theme-aware styles without re-render storms: the factory runs once per theme (at most four
 * times in the app's life), and the hook only reads the context.
 *
 * ```tsx
 * const useStyles = makeStyles((t) => ({
 *   title: { color: t.color.ink },
 *   card: { backgroundColor: t.color.surface, borderColor: t.color.hairline, ...t.shadow.surface },
 * }));
 * function Thing() {
 *   const s = useStyles();
 *   return <View style={s.card}>…</View>;
 * }
 * ```
 */
type Styles = Parameters<typeof StyleSheet.create>[0];

export function makeStyles<S extends Styles>(factory: (t: Theme) => S & Styles): () => Readonly<S> {
  const cache = new Map<Theme, Readonly<S>>();
  return function useStyles() {
    const t = useTheme();
    let s = cache.get(t);
    if (!s) {
      s = StyleSheet.create(factory(t));
      cache.set(t, s);
    }
    return s;
  };
}
