import type { FontSpec } from './fit';

/** Design space: everything is laid out on a 1080-wide canvas and scaled to the output. */
export const DESIGN_WIDTH = 1080;

export interface ThemeInput {
  id: string;
  name: string;
  fontFamily: string;
  background: string;
  foreground: string;
  accent: string;
}

/**
 * Platform-UI safe area in design units. Content stays below the top 12%
 * (status bar, tabs), above the bottom 22% (caption, username, music) and, in
 * the lower half, left of the right-hand 14% (like, comment, share rail).
 */
export interface SafeArea {
  height: number;
  top: number;
  bottom: number;
  left: number;
  /** Right edge for content that is entirely in the upper half. */
  rightUpper: number;
  /** Right edge for content that reaches into the lower half. */
  rightLower: number;
}

export function safeArea(height: number): SafeArea {
  return {
    height,
    top: Math.round(height * 0.12),
    bottom: Math.round(height * 0.78),
    left: 80,
    rightUpper: DESIGN_WIDTH - 80,
    rightLower: Math.round(DESIGN_WIDTH * 0.86),
  };
}

/** The bundled faces are registered under these names so system fonts never stand in. */
export const BUNDLED_TEXT = 'Kilo Inter';
export const BUNDLED_DISPLAY = 'Kilo Inter Display';

export function families(theme: ThemeInput): { text: string; display: string } {
  if (theme.fontFamily.trim().toLowerCase() === 'inter') return { text: BUNDLED_TEXT, display: BUNDLED_DISPLAY };
  // An unknown family: use it when the page has it, else fall back to the bundled Inter.
  return { text: theme.fontFamily, display: theme.fontFamily };
}

export function fonts(theme: ThemeInput) {
  const f = families(theme);
  return {
    headline: { family: f.display, weight: 800, tracking: -0.028 } satisfies FontSpec,
    heavy: { family: f.display, weight: 900, tracking: -0.04 } satisfies FontSpec,
    display: { family: f.display, weight: 700, tracking: -0.025 } satisfies FontSpec,
    bold: { family: f.text, weight: 700, tracking: -0.015 } satisfies FontSpec,
    semibold: { family: f.text, weight: 600, tracking: -0.01 } satisfies FontSpec,
    label: { family: f.text, weight: 800, tracking: 0.06, uppercase: true } satisfies FontSpec,
  };
}

// ---- colour ---------------------------------------------------------------

function parseHex(c: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function luminance(c: string): number | null {
  const rgb = parseHex(c);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return 1;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Of the theme background and foreground, whichever reads better on `fill`. */
export function inkOn(theme: ThemeInput, fill: string): string {
  return contrast(theme.background, fill) >= contrast(theme.foreground, fill) ? theme.background : theme.foreground;
}

/** A colour at reduced opacity, for any CSS colour. */
export function alpha(color: string, a: number): string {
  const rgb = parseHex(color);
  if (rgb) return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
  return `color-mix(in srgb, ${color} ${Math.round(a * 100)}%, transparent)`;
}

/** Soft shadow for cards over footage, tinted from the theme foreground on light cards. */
export function cardShadow(theme: ThemeInput): string {
  const dark = (luminance(theme.background) ?? 1) < 0.2;
  const tint = dark ? '#000000' : theme.foreground;
  return `0 18px 48px ${alpha(tint, dark ? 0.35 : 0.22)}, 0 4px 12px ${alpha(tint, dark ? 0.25 : 0.12)}`;
}
