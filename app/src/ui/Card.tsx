import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { color, radius, shadow } from './tokens';

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
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
}

/** Glass surface: white at 80%, hairline border, soft blue shadow, radius 20. */
export function Card({ children, style, padding = 16, paddingHorizontal, gap, flat, onPress, accessibilityLabel, accessibilityHint, testID }: CardProps) {
  // Longhands only: mixing `padding` with `paddingHorizontal` resolves differently on web.
  const pad: ViewStyle = { paddingTop: padding, paddingBottom: padding, paddingLeft: paddingHorizontal ?? padding, paddingRight: paddingHorizontal ?? padding };
  const base: StyleProp<ViewStyle> = [styles.card, !flat && shadow.surface, pad, { gap }, style];
  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        testID={testID}
        style={({ pressed }) => [base, pressed && styles.pressed]}
      >
        {children}
      </Pressable>
    );
  }
  return (
    <View style={base} testID={testID}>
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
  pressed: { opacity: 0.85 },
});
