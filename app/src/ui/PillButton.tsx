import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { accentGloss, color, shadow, size } from './tokens';
import { Text } from './type';
import type { IconName } from './Icon';
import { SymbolIcon } from './SymbolIcon';
import { PressableScale } from './PressableScale';
import { GlassSurface } from './GlassSurface';
import { hasLiquidGlass } from './glass';
import type { HapticKind } from './haptics';

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
  /** Haptic on press. Default: `medium` for primary, `light` otherwise (`warning` when destructive). */
  haptic?: HapticKind | false;
  /**
   * Secondary only: draw as Liquid Glass on iOS 26+ (the default). `false` keeps the white
   * pill, for a secondary button that sits on a white card where glass would not read.
   */
  glass?: boolean;
  children?: ReactNode;
}

/**
 * Pill buttons. `primary` is the blue gloss with white text on every platform; `secondary` is
 * Liquid Glass on iOS 26+ and a white pill with an outline elsewhere; `text` is a bare
 * 44pt-high label. Radius is half the height. All of them shrink on a spring and tap a haptic
 * on native (`PressableScale`).
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
  haptic,
  glass = true,
}: PillButtonProps) {
  const h = Math.max(
    size.touch,
    height ?? (variant === 'primary' ? size.primaryButton : variant === 'secondary' ? size.secondaryButton : size.touch),
  );
  const inactive = disabled || loading;
  const tone = variant === 'primary' ? 'white' : destructive ? 'cut' : 'ink';
  const fg = variant === 'primary' ? color.white : destructive ? color.cut : color.ink;
  const textVariant = variant === 'primary' && h >= size.primaryButton ? 'button' : 'body';
  const liquid = variant === 'secondary' && glass && hasLiquidGlass();
  const r = h / 2;

  const content = (
    <View style={styles.inner}>
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : icon ? (
        <SymbolIcon name={icon} color={fg} strokeWidth={2.2} size={20} />
      ) : null}
      <Text variant={textVariant} weight={600} tone={tone} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );

  return (
    <PressableScale
      onPress={onPress}
      disabled={inactive}
      motion="button"
      haptic={haptic ?? (destructive ? 'warning' : variant === 'primary' ? 'medium' : 'light')}
      restingOpacity={inactive ? 0.5 : 1}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      testID={testID}
      style={[
        styles.base,
        { height: h, borderRadius: r },
        liquid && styles.glassHost,
        variant === 'primary' && shadow.gloss,
        variant === 'secondary' && !liquid && styles.secondary,
        style,
      ]}
    >
      {variant === 'primary' ? (
        <LinearGradient
          colors={accentGloss.colors}
          locations={accentGloss.locations}
          style={[StyleSheet.absoluteFill, { borderRadius: r }]}
          pointerEvents="none"
        />
      ) : null}
      {liquid ? (
        // The label sits inside the glass so touches land on it and the glass reacts (interactive).
        <GlassSurface interactive radius={r} bordered={false} style={[styles.glassFill, { borderRadius: r }]}>
          {content}
        </GlassSurface>
      ) : (
        content
      )}
    </PressableScale>
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
  glassHost: { paddingHorizontal: 0, alignItems: 'stretch' },
  glassFill: { flex: 1, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
});
