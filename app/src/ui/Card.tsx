import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { color, radius, shadow } from './tokens';

export interface CardProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Inner padding; 16 like the mock-up. Use 0 with horizontal padding for list cards. */
  padding?: number;
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
export function Card({ children, style, padding = 16, gap, flat, onPress, accessibilityLabel, accessibilityHint, testID }: CardProps) {
  const base: StyleProp<ViewStyle> = [styles.card, !flat && shadow.surface, { padding, gap }, style];
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
