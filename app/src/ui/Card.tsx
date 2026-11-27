import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { color, radius, shadow } from './tokens';
import { PressableScale } from './PressableScale';
import { GlassSurface } from './GlassSurface';
import type { HapticKind } from './haptics';

export interface CardProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Inner padding; 16 like the mock-up. */
  padding?: number;
  /** Overrides the horizontal padding (list cards use padding 0, paddingHorizontal 16). */
  paddingHorizontal?: number;
  /** Space between children. */
  gap?: number;
  /** Drop the soft blue shadow (cards that sit flat in the mock-up). */
  flat?: boolean;
  /**
   * Draw the card as glass (`GlassSurface`: Liquid Glass on iOS 26+, blur on older iOS and
   * web, the translucent surface on Android) instead of the white-80% surface. Default false.
   */
  glass?: boolean;
  onPress?: () => void;
  /** Haptic on press (tappable cards). Default `light`. */
  haptic?: HapticKind | false;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
}

/** Glass surface: white at 80%, hairline border, soft blue shadow, radius 20. Tappable cards shrink slightly on press. */
export function Card({ children, style, padding = 16, paddingHorizontal, gap, flat, glass, onPress, haptic = 'light', accessibilityLabel, accessibilityHint, testID }: CardProps) {
  // Longhands only: mixing `padding` with `paddingHorizontal` resolves differently on web.
  const pad: ViewStyle = { paddingTop: padding, paddingBottom: padding, paddingLeft: paddingHorizontal ?? padding, paddingRight: paddingHorizontal ?? padding };
  const base: StyleProp<ViewStyle> = [glass ? styles.glassCard : styles.card, !flat && shadow.surface, pad, { gap }, style];
  // Glass is a layer behind the content, so the card keeps its own layout and padding.
  const background = glass ? <GlassSurface radius={radius.card} style={StyleSheet.absoluteFill} pointerEvents="none" /> : null;
  if (onPress) {
    return (
      <PressableScale
        onPress={onPress}
        motion="card"
        haptic={haptic}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        testID={testID}
        style={base}
      >
        {background}
        {children}
      </PressableScale>
    );
  }
  return (
    <View style={base} testID={testID}>
      {background}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.card,
  },
  glassCard: { borderRadius: radius.card },
});
