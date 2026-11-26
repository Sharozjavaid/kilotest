import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { accentGloss, color, shadow, size } from './tokens';
import { Text } from './type';
import { Icon, type IconName } from './Icon';

export type PillVariant = 'primary' | 'secondary' | 'text';

export interface PillButtonProps {
  label: string;
  onPress?: () => void;
  variant?: PillVariant;
  icon?: IconName;
  disabled?: boolean;
  loading?: boolean;
  /** Primary 56, secondary 52 by default. */
  height?: number;
  /** Destructive text tone (text variant). */
  destructive?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
  children?: ReactNode;
}

/**
 * Pill buttons. `primary` is the blue gloss with white text, `secondary` a white
 * pill with an outline, `text` a bare 44pt-high label. Radius is half the height.
 */
export function PillButton({
  label,
  onPress,
  variant = 'primary',
  icon,
  disabled,
  loading,
  height,
  destructive,
  style,
  accessibilityLabel,
  accessibilityHint,
  testID,
}: PillButtonProps) {
  const h = Math.max(
    size.touch,
    height ?? (variant === 'primary' ? size.primaryButton : variant === 'secondary' ? size.secondaryButton : size.touch),
  );
  const inactive = disabled || loading;
  const tone = variant === 'primary' ? 'white' : destructive ? 'cut' : 'ink';
  const fg = variant === 'primary' ? color.white : destructive ? color.cut : color.ink;
  const textVariant = variant === 'primary' && h >= size.primaryButton ? 'button' : 'body';

  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        { height: h, borderRadius: h / 2 },
        variant === 'primary' && shadow.gloss,
        variant === 'secondary' && styles.secondary,
        inactive && styles.disabled,
        pressed && !inactive && styles.pressed,
        style,
      ]}
    >
      {variant === 'primary' ? (
        <LinearGradient
          colors={accentGloss.colors}
          locations={accentGloss.locations}
          style={[StyleSheet.absoluteFill, { borderRadius: h / 2 }]}
          pointerEvents="none"
        />
      ) : null}
      <View style={styles.inner}>
        {loading ? (
          <ActivityIndicator color={fg} />
        ) : icon ? (
          <Icon name={icon} color={fg} strokeWidth={2.2} size={20} />
        ) : null}
        <Text variant={textVariant} weight={600} tone={tone} numberOfLines={1}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minWidth: size.touch,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'visible',
  },
  inner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  secondary: {
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: color.outline,
  },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.85 },
});
