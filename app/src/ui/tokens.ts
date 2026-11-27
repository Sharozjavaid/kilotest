/**
 * Design tokens. The single source for colour, type, radius and spacing.
 * Values come from docs/CONTRACTS.md section 6 and the approved mock-up
 * (docs/mockup/*.dc.html). Do not hard-code these values in screens.
 */

export const color = {
  ground: '#F5F8FC',
  skyTint: '#D9E8FF',
  surface: 'rgba(255,255,255,0.8)',
  /** Slightly more opaque glass used for tab bar and kept transcript rows. */
  surfaceStrong: 'rgba(255,255,255,0.85)',
  white: '#FFFFFF',
  ink: '#0B1220',
  muted: '#566074',
  accent: '#1F5EFF',
  accentPressed: '#1747C8',
  glossTop: '#2A66FF',
  glossBottom: '#1A52E8',
  track: '#D5DDEA',
  hairline: 'rgba(12,24,48,0.08)',
  outline: 'rgba(12,24,48,0.14)',
  cut: '#B4441E',
  record: '#F0442E',
  cameraScrim: '#2B3038',
  /** Off-state of a switch (mock-up NewBatch). */
  toggleOff: '#AEB8C8',
  /** Dashed border of a cut transcript row (mock-up Review). */
  cutRowBorder: '#9AA6B8',
  /** Dashed border of a drop zone (mock-up NewBatch). */
  dropBorder: '#9FB4DC',
  dropFill: 'rgba(255,255,255,0.5)',
  /** Player ground. */
  player: '#2B3038',
} as const;

/** Every colour token, by name. Light and dark sets have the same keys. */
export type Palette = { [K in keyof typeof color]: string } & {
  /** "White" fills that are content, not text: secondary pills on cards, off chips, step buttons. */
  fill: string;
  /** Text and glyphs on `accent` or the gloss. White in both modes. */
  onAccent: string;
  /** A pressed list row's background (shown at once, before the press motion). */
  pressedRow: string;
  /** Segmented control track and thumb (Android and web; iOS draws the native control). */
  segTrack: string;
  segThumb: string;
  /** Selected chip fill (with `accent` text). */
  chipOn: string;
};

/** The light set: `color` plus the semantic additions. */
export const lightColors: Palette = {
  ...color,
  fill: '#FFFFFF',
  onAccent: '#FFFFFF',
  pressedRow: 'rgba(12,24,48,0.04)',
  segTrack: 'rgba(12,24,48,0.06)',
  segThumb: '#FFFFFF',
  chipOn: color.skyTint,
};

/** The dark set (CONTRACTS section 6, "Dark mode"). Shadows are dropped in dark; borders carry the edges. */
export const darkColors: Palette = {
  ground: '#0A0F1A',
  skyTint: '#11244D',
  surface: 'rgba(28,34,48,0.85)',
  surfaceStrong: 'rgba(28,34,48,0.92)',
  white: '#FFFFFF',
  ink: '#F2F5FA',
  muted: '#9AA4B5',
  accent: '#4C7DFF',
  accentPressed: '#3A6AF0',
  glossTop: '#3A72FF',
  glossBottom: '#2257F0',
  track: '#2A3346',
  hairline: 'rgba(255,255,255,0.08)',
  outline: 'rgba(255,255,255,0.16)',
  cut: '#F0875A',
  record: '#FF5A45',
  cameraScrim: '#2B3038',
  toggleOff: '#3A4458',
  cutRowBorder: '#5A667A',
  dropBorder: '#3A5A99',
  dropFill: 'rgba(255,255,255,0.04)',
  player: '#2B3038',
  fill: '#1C2230',
  onAccent: '#FFFFFF',
  pressedRow: 'rgba(255,255,255,0.06)',
  segTrack: 'rgba(255,255,255,0.08)',
  segThumb: '#2A3346',
  chipOn: '#11244D',
};

/** Vertical gradient of the screen ground: sky tint fading into ground at 36%. */
export const groundGradient = {
  colors: [color.skyTint, color.ground, color.ground] as const,
  locations: [0, 0.36, 1] as const,
};

/** Primary button gloss. */
export const accentGloss = {
  colors: [color.glossTop, color.glossBottom] as const,
  locations: [0, 1] as const,
};

export const radius = {
  sm: 8,
  md: 12,
  row: 14,
  lg: 16,
  card: 20,
} as const;

export const space = {
  xs: 4,
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  gutter: 20,
} as const;

export const size = {
  touch: 44,
  primaryButton: 56,
  secondaryButton: 52,
  tabBar: 72,
} as const;

/** Shadows as React Native style props. `boxShadow` works on native (new arch) and web. */
export const shadow = {
  surface: { boxShadow: '0 8px 24px rgba(31,94,255,0.08)' },
  gloss: { boxShadow: '0 8px 20px rgba(31,94,255,0.28), inset 0 1px 0 rgba(255,255,255,0.35)' },
  player: { boxShadow: '0 12px 28px rgba(31,94,255,0.18)' },
  selected: { boxShadow: '0 8px 20px rgba(31,94,255,0.2)' },
} as const;

/** Inter font family names, one per weight, as loaded in src/ui/fonts.ts. */
export const fontFamily = {
  400: 'Inter_400Regular',
  500: 'Inter_500Medium',
  600: 'Inter_600SemiBold',
  700: 'Inter_700Bold',
} as const;

export type Weight = keyof typeof fontFamily;
