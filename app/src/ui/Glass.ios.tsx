import { StyleSheet, View, type ViewStyle } from 'react-native';
import { GlassContainer, GlassView } from 'expo-glass-effect';
import { BlurView } from 'expo-blur';
import { useReducedTransparency } from './a11y';
import { glassFallback, glassKinds, glassModeFor, hasLiquidGlass } from './glass';
import { useTheme } from './theme';
import type { GlassGroupProps, GlassProps } from './Glass.types';

export type { GlassGroupProps, GlassProps } from './Glass.types';

/**
 * Kilo's one glass primitive (design brief 5.1), iOS. iOS 26+: the system Liquid Glass
 * (`GlassView`, regular or clear, interactive for buttons, `accent` tint when asked). iOS 16.4
 * to 25: the system thin-material blur under a white 0.55 veil (dark: camera scrim 0.35) with a
 * hairline and the soft surface shadow. Reduce Transparency: a solid surface. Radius and
 * padding come from `kind` and are the same on every path, so layouts never shift.
 */
export function Glass({ kind = 'panel', appearance = 'auto', tint, interactive, radius, variant = 'regular', style, children, ...rest }: GlassProps) {
  const theme = useTheme();
  const reduceTransparency = useReducedTransparency();
  const scheme = appearance === 'auto' ? theme.scheme : appearance;
  const mode = glassModeFor({ os: 'ios', liquidGlass: hasLiquidGlass(), reduceTransparency });
  const k = glassKinds[kind];
  const r = radius ?? k.radius;
  const box: ViewStyle = { borderRadius: r, borderCurve: 'continuous', paddingVertical: k.paddingVertical, paddingHorizontal: k.paddingHorizontal };
  const edge = theme.highContrast ? theme.color.outline : scheme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(12,24,48,0.08)';

  if (mode === 'liquid') {
    return (
      <GlassView
        {...rest}
        glassEffectStyle={variant}
        tintColor={tint === 'accent' ? theme.color.accent : undefined}
        isInteractive={!!interactive}
        colorScheme={scheme}
        style={[box, style]}
      >
        {children}
        {theme.highContrast ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: r, borderWidth: 1, borderColor: edge }]} /> : null}
      </GlassView>
    );
  }

  const fb = glassFallback(mode === 'blur' ? 'blur' : 'solid', scheme, 'ios');
  const fill = tint === 'accent' ? theme.color.accent : fb.backgroundColor;
  return (
    <View {...rest} style={[box, fb.shadow && tint !== 'accent' ? theme.shadow.surface : null, style]}>
      {/* The blur sits in its own clipped layer, so the surface itself need not clip (which would cut off its shadow). */}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: r, overflow: 'hidden' }]}>
        {fb.blurTint && tint !== 'accent' ? <BlurView tint={fb.blurTint} intensity={100} style={StyleSheet.absoluteFill} /> : null}
        <View style={[StyleSheet.absoluteFill, { backgroundColor: fill }]} />
      </View>
      {children}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: r, borderWidth: 1, borderColor: edge }]} />
    </View>
  );
}

/**
 * Groups glass shapes so they blend and morph into each other (iOS 26 `GlassContainer`,
 * spacing 8 by default). Elsewhere a plain View.
 *
 * ```tsx
 * <GlassGroup style={{ flexDirection: 'row', gap: 8 }}>
 *   <IconButton icon="list" label="All videos" onPress={…} />
 *   <IconButton icon="plus" label="New" onPress={…} />
 * </GlassGroup>
 * ```
 */
export function GlassGroup({ spacing = 8, ...rest }: GlassGroupProps) {
  if (hasLiquidGlass()) return <GlassContainer spacing={spacing} {...rest} />;
  return <View {...rest} />;
}
