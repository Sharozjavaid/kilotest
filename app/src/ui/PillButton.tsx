import type { ReactNode } from 'react';
import { ActivityIndicator, Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { size } from './tokens';
import { Text } from './type';
import type { IconName } from './Icon';
import { SymbolIcon } from './SymbolIcon';
import { PressableScale } from './PressableScale';
import { Glass } from './Glass';
import { makeStyles, useTheme } from './theme';
import { motionHaptics } from './motionPresets';
import type { HapticKind } from './haptics';

export type PillVariant = 'primary' | 'secondary' | 'text';

export interface PillButtonProps {
  label: string;
  onPress?: () => void;
  variant?: PillVariant;
  icon?: IconName;
  disabled?: boolean;
  loading?: boolean;
  /** Primary 56 (footer), 48 (in a glass bar) or 44 (inline); secondary 52 or 44. */
  height?: number;
  /** Destructive text tone (text variant). */
  destructive?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
  /** Haptic on press. Default: `light` for primary (a call to action), none otherwise. */
  haptic?: HapticKind | false;
  /**
   * Secondary only. `glass` (default): Liquid Glass on iOS 26, the blur glass on older iOS, and
   * the content version (white fill, 1px outline) on Android and web, which is what the
   * brief's fallback for glass buttons comes to there. `content`: the content version
   * everywhere, for a secondary button on a card (glass never sits on content).
   */
  surface?: 'glass' | 'content';
  children?: ReactNode;
}

const useStyles = makeStyles((t) => ({
  base: { minWidth: size.touch, paddingHorizontal: 24, alignItems: 'center', justifyContent: 'center', overflow: 'visible' },
  inner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  content: { backgroundColor: t.color.fill, borderWidth: 1, borderColor: t.color.outline },
  primaryDisabled: { backgroundColor: t.color.track },
  glassHost: { paddingHorizontal: 0, alignItems: 'stretch' },
  glassFill: { flex: 1, paddingHorizontal: 24, alignItems: 'center', justifyContent: 'center' },
}));

/**
 * Pill buttons (design brief 5.3). `primary`: the blue gloss with white text on every platform,
 * the one tinted thing on a screen; disabled is a `track` fill with a `muted` label. `secondary`:
 * glass or the content version (see `surface`). `text`: a bare 44pt `accent` label (`cut` when
 * destructive). Radius is half the height. All shrink on the `press` spring on native; only
 * primary taps a haptic.
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
  surface = 'glass',
}: PillButtonProps) {
  const t = useTheme();
  const s = useStyles();
  const h = Math.max(size.touch, height ?? (variant === 'primary' ? size.primaryButton : variant === 'secondary' ? size.secondaryButton : size.touch));
  const inactive = disabled || loading;
  const primary = variant === 'primary';
  const fg = primary ? (disabled ? t.color.muted : t.color.onAccent) : variant === 'text' ? (destructive ? t.color.cut : t.color.accent) : destructive ? t.color.cut : t.color.ink;
  const glass = variant === 'secondary' && surface === 'glass' && Platform.OS === 'ios';
  const r = h / 2;
  // Inter 600: 17 on a 56 primary, 16 on smaller pills and secondaries, 15 on text buttons.
  const fontSize = variant === 'text' ? 15 : primary && h >= size.primaryButton ? 17 : 16;

  const content = (
    <View style={s.inner}>
      {loading ? <ActivityIndicator color={fg} /> : icon ? <SymbolIcon name={icon} color={fg} strokeWidth={2.2} size={20} /> : null}
      <Text variant="button" weight={600} numberOfLines={1} style={{ color: fg, fontSize }}>
        {label}
      </Text>
    </View>
  );

  return (
    <PressableScale
      onPress={onPress}
      disabled={inactive}
      motion="button"
      haptic={haptic ?? (primary ? motionHaptics.primaryPress : false)}
      // A disabled primary shows by its fill; the others dim.
      restingOpacity={inactive && !(primary && disabled) ? 0.5 : 1}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      testID={testID}
      style={[
        s.base,
        { height: h, borderRadius: r },
        variant === 'text' && { paddingHorizontal: 16 },
        glass && s.glassHost,
        primary && !disabled && t.shadow.gloss,
        primary && disabled && s.primaryDisabled,
        variant === 'secondary' && !glass && s.content,
        style,
      ]}
    >
      {primary && !disabled ? (
        <LinearGradient colors={t.accentGloss.colors} locations={t.accentGloss.locations} style={[StyleSheet.absoluteFill, { borderRadius: r }]} pointerEvents="none" />
      ) : null}
      {glass ? (
        // The label sits inside the glass so touches land on it and the iOS 26 glass shimmers.
        <Glass kind="button" interactive radius={r} style={s.glassFill}>
          {content}
        </Glass>
      ) : (
        content
      )}
    </PressableScale>
  );
}
