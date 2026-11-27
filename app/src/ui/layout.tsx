import type { ReactNode } from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { router } from 'expo-router';
import { size } from './tokens';
import { Text } from './type';
import type { IconName } from './Icon';
import { SymbolIcon } from './SymbolIcon';
import { PressableScale } from './PressableScale';
import { Glass } from './Glass';
import { makeStyles, useColors } from './theme';
import type { HapticKind } from './haptics';

const useStyles = makeStyles((t) => ({
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, height: size.touch },
  back: { width: size.touch, height: size.touch, marginLeft: -12, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  rowText: { flex: 1, gap: 2 },
  divider: { borderTopWidth: 1, borderTopColor: t.color.hairline },
  section: { paddingBottom: 4 },
  iconButton: { width: size.touch, height: size.touch, borderRadius: size.touch / 2, alignItems: 'center', justifyContent: 'center' },
  iconPlain: { borderWidth: 1, borderColor: t.color.hairline, backgroundColor: t.color.surface },
  iconGlass: { width: size.touch, height: size.touch, alignItems: 'center', justifyContent: 'center' },
}));

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

/**
 * 44pt in-content header row: back chevron, title, muted meta. On iOS route screens prefer
 * `<Screen header={…}>`, which uses the native navigation bar instead; sheets and modals keep this.
 */
export function Header({ title, meta, right, onBack, noBack, size: titleSize = 'title' }: HeaderProps) {
  const s = useStyles();
  const c = useColors();
  const back = onBack ?? (() => (router.canGoBack() ? router.back() : router.replace('/')));
  return (
    <View style={s.header}>
      {noBack ? null : (
        <PressableScale onPress={back} motion="icon" accessibilityRole="button" accessibilityLabel="Back" hitSlop={4} style={s.back}>
          <SymbolIcon name="chevronLeft" size={22} strokeWidth={2.2} color={c.ink} />
        </PressableScale>
      )}
      <Text variant={titleSize} style={s.title} numberOfLines={1} accessibilityRole="header">
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
  /** Haptic on press. Default none (the brief keeps row taps silent). */
  haptic?: HapticKind | false;
  testID?: string;
}

/**
 * A settings or list row: title, optional subtitle, something on the right. Tappable rows show
 * the pressed background at once and the `press` scale (0.98) on native.
 */
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
  haptic = false,
  testID,
}: RowProps) {
  const s = useStyles();
  const c = useColors();
  const content = (
    <>
      {left}
      <View style={s.rowText}>
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
      {chevron ? <SymbolIcon name="chevronRight" size={Platform.OS === 'ios' ? 14 : 18} color={c.muted} /> : null}
    </>
  );
  const rowStyle = [s.row, { minHeight: minHeight ?? (subtitle ? 56 : 52) }, divider && s.divider, style];
  if (onPress) {
    return (
      <PressableScale
        onPress={onPress}
        motion="row"
        haptic={haptic}
        pressedBackgroundColor={c.pressedRow}
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
  const s = useStyles();
  return (
    <Text variant="secondary" tone="muted" style={s.section} accessibilityRole="header">
      {children}
    </Text>
  );
}

/**
 * Small icon-only round button (44pt). With `glass` (default) it is `<Glass kind="button">` on
 * iOS (Liquid Glass on 26, interactive; blur before) and the translucent surface with a
 * hairline elsewhere. Native nav-bar buttons are not this: use `Screen`'s `header.actions`.
 */
export function IconButton({
  icon,
  label,
  onPress,
  glass = true,
  disabled,
  haptic = false,
  testID,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  glass?: boolean;
  disabled?: boolean;
  haptic?: HapticKind | false;
  testID?: string;
}) {
  const s = useStyles();
  const c = useColors();
  const native = glass && Platform.OS === 'ios';
  const glyph = <SymbolIcon name={icon} size={Platform.OS === 'ios' ? 17 : 20} strokeWidth={Platform.OS === 'ios' ? 2.2 : 2} color={c.ink} />;
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
      testID={testID}
      style={[s.iconButton, glass && !native && s.iconPlain]}
    >
      {native ? (
        <Glass kind="button" interactive style={s.iconGlass}>
          {glyph}
        </Glass>
      ) : (
        glyph
      )}
    </PressableScale>
  );
}
