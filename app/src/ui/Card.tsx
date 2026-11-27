import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { radius } from './tokens';
import { PressableScale } from './PressableScale';
import { makeStyles, useTheme } from './theme';
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
  onPress?: () => void;
  /** Haptic on press (tappable cards). Default none. */
  haptic?: HapticKind | false;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
}

const useStyles = makeStyles((t) => ({
  card: { backgroundColor: t.color.surface, borderWidth: 1, borderColor: t.color.hairline, borderRadius: radius.card },
}));

/**
 * Content card (design brief 5.2): `surface` fill, 1px `hairline`, `shadow.surface` (none in
 * dark), radius 20, padding 16. Content, so never glass. Tappable cards use `press` (0.98).
 */
export function Card({ children, style, padding = 16, paddingHorizontal, gap, flat, onPress, haptic = false, accessibilityLabel, accessibilityHint, testID }: CardProps) {
  const t = useTheme();
  const s = useStyles();
  // Longhands only: mixing `padding` with `paddingHorizontal` resolves differently on web.
  const pad: ViewStyle = { paddingTop: padding, paddingBottom: padding, paddingLeft: paddingHorizontal ?? padding, paddingRight: paddingHorizontal ?? padding };
  const base: StyleProp<ViewStyle> = [s.card, !flat && t.shadow.surface, pad, { gap }, style];
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
        {children}
      </PressableScale>
    );
  }
  return (
    <View style={base} testID={testID}>
      {children}
    </View>
  );
}
