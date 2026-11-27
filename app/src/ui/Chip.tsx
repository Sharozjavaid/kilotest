import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { interpolateColor, useAnimatedStyle } from 'react-native-reanimated';
import type { IconName } from './Icon';
import { SymbolIcon } from './SymbolIcon';
import { PressableScale } from './PressableScale';
import { Glass } from './Glass';
import { Text } from './type';
import { makeStyles, useColors } from './theme';
import { useMotionValue } from './motion';
import { motionHaptics } from './motionPresets';

export interface ChipProps {
  label: string;
  /**
   * - `toggle` (default): off is a white fill with a 1px `outline`; on (`selected`) is a `skyTint`
   *   fill with `accent` 600 text. The fill moves with `select` on native.
   * - `status`: a non-tappable `accent` on `skyTint` label ("Review").
   * - `pro`: the 20pt `accent` "Pro" capsule.
   * - `glass`: clear glass with white text, only over video (hook labels, "Preview").
   */
  kind?: 'toggle' | 'status' | 'pro' | 'glass';
  selected?: boolean;
  onPress?: () => void;
  icon?: IconName;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

const useStyles = makeStyles((t) => ({
  chip: { height: 32, borderRadius: 16, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' },
  off: { backgroundColor: t.color.fill, borderWidth: 1, borderColor: t.color.outline },
  on: { backgroundColor: t.color.chipOn, borderWidth: 1, borderColor: t.color.chipOn },
  pro: { height: 20, borderRadius: 10, paddingHorizontal: 7, backgroundColor: t.color.accent, alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-start' },
  glass: { height: 28, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' },
}));

const native = Platform.OS !== 'web';

/** Chips (design brief 5.4). 32 high with a 44pt touch target. */
export function Chip({ label, kind = 'toggle', selected = false, onPress, icon, accessibilityLabel, accessibilityHint, testID, style }: ChipProps) {
  const s = useStyles();
  const c = useColors();

  if (kind === 'pro') {
    return (
      <View style={[s.pro, style]} testID={testID} accessibilityLabel={accessibilityLabel ?? 'Pro'}>
        <Text variant="label" weight={700} tone="white" style={{ fontSize: 11 }}>
          {label}
        </Text>
      </View>
    );
  }
  if (kind === 'glass') {
    return (
      <Glass kind="button" variant="clear" appearance="dark" radius={14} style={[s.glass, style]} testID={testID}>
        {icon ? <SymbolIcon name={icon} size={12} color={c.white} /> : null}
        <Text variant="label" weight={600} tone="white">
          {label}
        </Text>
      </Glass>
    );
  }

  const on = kind === 'status' || selected;
  const body = (
    <>
      {icon ? <SymbolIcon name={icon} size={14} color={on ? c.accent : c.ink} strokeWidth={2.2} /> : null}
      <Text variant="secondary" weight={on ? 600 : 500} tone={on ? 'accent' : 'ink'} numberOfLines={1}>
        {label}
      </Text>
    </>
  );

  if (kind === 'status' || !onPress) {
    return (
      <View style={[s.chip, on ? s.on : s.off, style]} testID={testID}>
        {body}
      </View>
    );
  }

  return (
    <PressableScale
      onPress={onPress}
      motion="chip"
      haptic={motionHaptics.select}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected }}
      testID={testID}
      style={[s.chip, native ? null : selected ? s.on : s.off, style]}
    >
      {native ? <ChipFill selected={selected} /> : null}
      {body}
    </PressableScale>
  );
}

/** The fill and border, cross-fading between off and on with `select`. */
function ChipFill({ selected }: { selected: boolean }) {
  const c = useColors();
  const v = useMotionValue(selected ? 1 : 0, 'select');
  const style = useAnimatedStyle(
    () => ({
      backgroundColor: interpolateColor(v.value, [0, 1], [c.fill, c.chipOn]),
      borderColor: interpolateColor(v.value, [0, 1], [c.outline, c.chipOn]),
    }),
    [c],
  );
  return <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 16, borderWidth: 1 }, style]} />;
}
