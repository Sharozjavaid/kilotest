import { Platform, StyleSheet, View, type ViewStyle } from 'react-native';
import { useReducedTransparency } from './a11y';
import { glassFallback, glassKinds, glassModeFor } from './glass';
import { useTheme } from './theme';
import type { GlassGroupProps, GlassProps } from './Glass.types';

export type { GlassGroupProps, GlassProps } from './Glass.types';

/**
 * Kilo's one glass primitive (design brief 5.1), for Android and web; iOS is `Glass.ios.tsx`.
 * Web: a CSS backdrop blur under a white 0.72 veil. Android: solid white 0.94 with elevation 2
 * (never a heavy blur there). Both draw a 1px hairline (an `outline` under Increase Contrast)
 * as an overlay, so it takes no layout space and sizes match iOS exactly.
 *
 * Glass is for chrome that floats over content, never for content (cards, rows, lists).
 *
 * ```tsx
 * <Glass kind="bar" style={{ flexDirection: 'row', gap: 8 }}>
 *   <PillButton label="Looks good" height={48} />
 * </Glass>
 * ```
 */
export function Glass({ kind = 'panel', appearance = 'auto', tint, interactive: _interactive, radius, variant: _variant, style, children, ...rest }: GlassProps) {
  const theme = useTheme();
  const reduceTransparency = useReducedTransparency();
  const scheme = appearance === 'auto' ? theme.scheme : appearance;
  const mode = glassModeFor({ os: Platform.OS, liquidGlass: false, reduceTransparency });
  const k = glassKinds[kind];
  const r = radius ?? k.radius;
  const fb = glassFallback(mode === 'liquid' ? 'solid' : mode, scheme, Platform.OS);
  const surface: ViewStyle = {
    borderRadius: r,
    paddingVertical: k.paddingVertical,
    paddingHorizontal: k.paddingHorizontal,
    backgroundColor: tint === 'accent' ? theme.color.accent : fb.backgroundColor,
    elevation: fb.elevation,
  };
  // react-native-web passes backdrop-filter through to CSS.
  const css = fb.backdropFilter ? ({ backdropFilter: fb.backdropFilter, WebkitBackdropFilter: fb.backdropFilter } as unknown as ViewStyle) : null;
  return (
    <View {...rest} style={[surface, css, style]}>
      {children}
      <View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { borderRadius: r, borderWidth: 1, borderColor: theme.highContrast ? theme.color.outline : scheme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(12,24,48,0.08)' }]}
      />
    </View>
  );
}

/** A plain View off iOS 26. */
export function GlassGroup({ spacing: _spacing, ...rest }: GlassGroupProps) {
  return <View {...rest} />;
}
