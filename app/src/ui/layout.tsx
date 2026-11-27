import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { router } from 'expo-router';
import { color, size } from './tokens';
import { Text } from './type';
import type { IconName } from './Icon';
import { SymbolIcon } from './SymbolIcon';
import { PressableScale } from './PressableScale';
import { GlassSurface } from './GlassSurface';
import { hasLiquidGlass } from './glass';
import type { HapticKind } from './haptics';

// ---- Header -----------------------------------------------------------------

export interface HeaderProps {
  title: string;
  /** Muted text on the right (e.g. "1 of 30"). */
  meta?: string;
  /** Replaces `meta` with a control. */
  right?: ReactNode;
  /** Defaults to router.back(), or Home when there is no history. */
  onBack?: () => void;
  /** Hide the back button (root screens). */
  noBack?: boolean;
  size?: 'title' | 'titleSm';
}

/** 44pt header row: back chevron, title, muted meta. */
export function Header({ title, meta, right, onBack, noBack, size: titleSize = 'title' }: HeaderProps) {
  const back = onBack ?? (() => (router.canGoBack() ? router.back() : router.replace('/')));
  return (
    <View style={styles.header}>
      {noBack ? null : (
        <PressableScale onPress={back} motion="icon" haptic={false} accessibilityRole="button" accessibilityLabel="Back" hitSlop={4} style={styles.back}>
          <SymbolIcon name="chevronLeft" size={22} strokeWidth={2.2} />
        </PressableScale>
      )}
      <Text variant={titleSize} style={styles.title} numberOfLines={1} accessibilityRole="header">
        {title}
      </Text>
      {right ?? (meta ? <Text variant="secondary" tone="muted">{meta}</Text> : null)}
    </View>
  );
}

// ---- Row --------------------------------------------------------------------

export interface RowProps {
  title: string;
  subtitle?: string;
  /** Control or value on the right. */
  right?: ReactNode;
  /** Hairline above the row (every row after the first in a card). */
  divider?: boolean;
  minHeight?: number;
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  /** Leading element (thumbnail). */
  left?: ReactNode;
  titleWeight?: 400 | 500 | 600;
  chevron?: boolean;
  /** Haptic on press (tappable rows). Default `light`. */
  haptic?: HapticKind | false;
  testID?: string;
}

/** A settings or list row: title, optional subtitle, something on the right. */
export function Row({
  title,
  subtitle,
  right,
  divider,
  minHeight,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  style,
  left,
  titleWeight = 500,
  chevron,
  haptic = 'light',
  testID,
}: RowProps) {
  const content = (
    <>
      {left}
      <View style={styles.rowText}>
        <Text variant="body" weight={titleWeight} numberOfLines={2}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant={left ? 'secondary' : 'label'} tone="muted" numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
      {chevron ? <SymbolIcon name="chevronRight" size={18} color={color.muted} /> : null}
    </>
  );
  const rowStyle = [
    styles.row,
    { minHeight: minHeight ?? (subtitle ? 56 : 52) },
    divider && styles.divider,
    style,
  ];
  if (onPress) {
    return (
      <PressableScale
        onPress={onPress}
        motion="row"
        haptic={haptic}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? (subtitle ? `${title}, ${subtitle}` : title)}
        accessibilityHint={accessibilityHint}
        testID={testID}
        style={rowStyle}
      >
        {content}
      </PressableScale>
    );
  }
  return (
    <View style={rowStyle} testID={testID}>
      {content}
    </View>
  );
}

/** Muted section label above a list ("Ready to review"). */
export function SectionLabel({ children }: { children: string }) {
  return (
    <Text variant="secondary" tone="muted" style={styles.section} accessibilityRole="header">
      {children}
    </Text>
  );
}

/**
 * Small icon-only round button (44pt), glass or plain. With `glass` it is Liquid Glass on
 * iOS 26+ (interactive) and the translucent surface with a hairline elsewhere.
 */
export function IconButton({
  icon,
  label,
  onPress,
  glass = true,
  disabled,
  haptic = 'light',
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  glass?: boolean;
  disabled?: boolean;
  haptic?: HapticKind | false;
}) {
  const liquid = glass && hasLiquidGlass();
  const glyph = <SymbolIcon name={icon} size={20} />;
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      motion="icon"
      haptic={haptic}
      restingOpacity={disabled ? 0.6 : 1}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={[styles.iconButton, glass && !liquid && styles.iconGlass]}
    >
      {liquid ? (
        <GlassSurface interactive radius={size.touch / 2} bordered={false} style={styles.iconLiquid}>
          {glyph}
        </GlassSurface>
      ) : (
        glyph
      )}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, height: size.touch },
  back: { width: size.touch, height: size.touch, marginLeft: -12, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  rowText: { flex: 1, gap: 2 },
  divider: { borderTopWidth: 1, borderTopColor: color.hairline },
  section: { paddingBottom: 4 },
  iconButton: {
    width: size.touch,
    height: size.touch,
    borderRadius: size.touch / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconGlass: { borderWidth: 1, borderColor: color.hairline, backgroundColor: color.surface },
  iconLiquid: { width: size.touch, height: size.touch, alignItems: 'center', justifyContent: 'center' },
});
