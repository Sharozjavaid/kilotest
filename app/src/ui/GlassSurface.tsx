import { Platform, StyleSheet, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { glassModeFor } from './glass';
import { color, radius as radii, shadow } from './tokens';
import type { GlassGroupProps, GlassSurfaceProps } from './GlassSurface.types';

export type { GlassGroupProps, GlassSurfaceProps } from './GlassSurface.types';

/**
 * A glass panel (Android and web; iOS is `GlassSurface.ios.tsx`). Web: a CSS backdrop blur
 * under the translucent `surface` token. Android: the `surface` token alone, since a live blur
 * there costs a full render pass of what is behind on every frame.
 */
export function GlassSurface({
  radius = radii.card,
  tint,
  interactive: _interactive,
  variant = 'regular',
  bordered = true,
  elevated,
  style,
  children,
  ...rest
}: GlassSurfaceProps) {
  const mode = glassModeFor({ os: Platform.OS, liquidGlass: false, reduceTransparency: false });
  const shape = { borderRadius: radius };
  return (
    <View
      {...rest}
      style={[shape, mode !== 'blur' && styles.surface, bordered && styles.border, elevated && shadow.surface, style]}
    >
      {mode === 'blur' ? (
        <View style={[StyleSheet.absoluteFill, shape, styles.clip]} pointerEvents="none">
          <BlurView tint="light" intensity={variant === 'clear' ? 30 : 60} style={StyleSheet.absoluteFill} />
          <View style={[StyleSheet.absoluteFill, variant === 'clear' ? null : styles.surface]} />
        </View>
      ) : null}
      {tint ? <View style={[StyleSheet.absoluteFill, shape, { backgroundColor: tint, opacity: 0.18 }]} pointerEvents="none" /> : null}
      {children}
    </View>
  );
}

/** A plain View off iOS 26 (see `GlassSurface.ios.tsx`). */
export function GlassGroup({ spacing: _spacing, ...rest }: GlassGroupProps) {
  return <View {...rest} />;
}

const styles = StyleSheet.create({
  surface: { backgroundColor: color.surface },
  clip: { overflow: 'hidden' },
  border: { borderWidth: 1, borderColor: color.hairline },
});
