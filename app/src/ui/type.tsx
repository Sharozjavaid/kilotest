import { Text as RNText, type TextProps as RNTextProps, type TextStyle, StyleSheet } from 'react-native';
import { color, fontFamily, type Weight } from './tokens';

/** Type scale taken from the mock-up. Body 15, secondary 13, label 12. */
export const typeScale = {
  wordmark: { size: 28, weight: 700, tracking: -1.2 },
  display: { size: 40, weight: 700, tracking: -1.5, lineHeight: 40 },
  headline: { size: 28, weight: 600, tracking: -0.8, lineHeight: 32 },
  goal: { size: 24, weight: 600, tracking: -0.5 },
  title: { size: 22, weight: 600, tracking: -0.5 },
  titleSm: { size: 20, weight: 600, tracking: -0.4 },
  button: { size: 17, weight: 600, tracking: 0 },
  bodyLg: { size: 16, weight: 600, tracking: 0 },
  body: { size: 15, weight: 400, tracking: 0 },
  transcript: { size: 14, weight: 400, tracking: 0, lineHeight: 19 },
  secondary: { size: 13, weight: 400, tracking: 0 },
  label: { size: 12, weight: 400, tracking: 0 },
} as const satisfies Record<string, { size: number; weight: Weight; tracking: number; lineHeight?: number }>;

export type TypeVariant = keyof typeof typeScale;

/** Style object for a variant, for use outside <Text>. */
export function typeStyle(variant: TypeVariant, weight?: Weight): TextStyle {
  const t = typeScale[variant];
  const w = weight ?? t.weight;
  return {
    fontFamily: fontFamily[w],
    fontSize: t.size,
    letterSpacing: t.tracking,
    ...('lineHeight' in t ? { lineHeight: t.lineHeight } : null),
  };
}

export interface TextProps extends RNTextProps {
  variant?: TypeVariant;
  weight?: Weight;
  tone?: 'ink' | 'muted' | 'accent' | 'cut' | 'white';
  strike?: boolean;
  center?: boolean;
}

const toneColor = {
  ink: color.ink,
  muted: color.muted,
  accent: color.accent,
  cut: color.cut,
  white: color.white,
} as const;

export function Text({ variant = 'body', weight, tone = 'ink', strike, center, style, ...rest }: TextProps) {
  return (
    <RNText
      {...rest}
      style={[
        typeStyle(variant, weight),
        { color: toneColor[tone] },
        strike && styles.strike,
        center && styles.center,
        style,
      ]}
    />
  );
}

/** Lowercase "kilo", weight 700, letter-spacing -1.2 at 28px. */
export function Wordmark({ size = 28 }: { size?: number }) {
  return (
    <RNText
      accessibilityRole="header"
      accessibilityLabel="kilo"
      style={{ fontFamily: fontFamily[700], fontSize: size, letterSpacing: (-1.2 * size) / 28, color: color.ink }}
    >
      kilo
    </RNText>
  );
}

const styles = StyleSheet.create({
  strike: { textDecorationLine: 'line-through' },
  center: { textAlign: 'center' },
});
