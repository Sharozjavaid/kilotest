import { StyleSheet, View } from 'react-native';
import { GlassContainer, GlassView } from 'expo-glass-effect';
import { BlurView } from 'expo-blur';
import { useReducedTransparency } from './a11y';
import { glassModeFor, hasLiquidGlass } from './glass';
import { color, radius as radii, shadow } from './tokens';
import type { GlassGroupProps, GlassSurfaceProps } from './GlassSurface.types';

export type { GlassGroupProps, GlassSurfaceProps } from './GlassSurface.types';

/** White veil over the system blur: lighter than `surface` so the blur still reads as glass. */
const VEIL = 'rgba(255,255,255,0.55)';

/**
 * A glass panel. iOS 26+: the system Liquid Glass (`GlassView`). Earlier iOS: the system blur
 * under a white veil with the hairline border. Reduce Transparency: an opaque white surface
 * (the system glass handles that setting itself).
 *
 * ```tsx
 * <GlassSurface radius={22} interactive style={{ padding: 12 }}>
 *   <Text>…</Text>
 * </GlassSurface>
 * ```
 */
export function GlassSurface({
  radius = radii.card,
  tint,
  interactive,
  variant = 'regular',
  bordered = true,
  elevated,
  style,
  children,
  ...rest
}: GlassSurfaceProps) {
  const reduceTransparency = useReducedTransparency();
  const mode = glassModeFor({ os: 'ios', liquidGlass: hasLiquidGlass(), reduceTransparency });
  const shape = { borderRadius: radius, borderCurve: 'continuous' as const };

  if (mode === 'liquid') {
    return (
      <GlassView
        {...rest}
        glassEffectStyle={variant}
        tintColor={tint}
        isInteractive={!!interactive}
        colorScheme="light"
        style={[shape, style]}
      >
        {children}
      </GlassView>
    );
  }

  // The blur sits in its own clipped layer so the panel itself need not clip (which would cut
  // off its shadow and anything a child draws outside it).
  return (
    <View {...rest} style={[shape, bordered && styles.border, elevated && shadow.surface, mode === 'solid' && styles.solid, style]}>
      {mode === 'blur' ? (
        <View style={[StyleSheet.absoluteFill, shape, styles.clip]} pointerEvents="none">
          <BlurView tint={variant === 'clear' ? 'systemUltraThinMaterialLight' : 'systemMaterialLight'} intensity={80} style={StyleSheet.absoluteFill} />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: variant === 'clear' ? 'transparent' : VEIL }]} />
          {tint ? <View style={[StyleSheet.absoluteFill, { backgroundColor: tint, opacity: 0.18 }]} /> : null}
        </View>
      ) : null}
      {children}
    </View>
  );
}

/**
 * Groups glass shapes so that they merge and morph into each other when close (iOS 26+), as
 * the system does for toolbar buttons. Elsewhere a plain View.
 *
 * ```tsx
 * <GlassGroup spacing={10} style={{ flexDirection: 'row', gap: 8 }}>
 *   <GlassSurface radius={22} interactive>…</GlassSurface>
 *   <GlassSurface radius={22} interactive>…</GlassSurface>
 * </GlassGroup>
 * ```
 */
export function GlassGroup({ spacing = 12, ...rest }: GlassGroupProps) {
  if (hasLiquidGlass()) return <GlassContainer spacing={spacing} {...rest} />;
  return <View {...rest} />;
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
  border: { borderWidth: 1, borderColor: color.hairline },
  solid: { backgroundColor: color.white },
});
