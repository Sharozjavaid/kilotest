import { useState } from 'react';
import { Platform, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { PressableScale } from './PressableScale';
import { Text } from './type';
import { makeStyles } from './theme';
import { useMotionValue } from './motion';
import { motionHaptics } from './motionPresets';
import type { SegmentedControlProps } from './SegmentedControl.types';

export type { Segment, SegmentedControlProps } from './SegmentedControl.types';

const PAD = 2;
const HEIGHT = 36;
const native = Platform.OS !== 'web';

const useStyles = makeStyles((t) => ({
  track: { flexDirection: 'row', backgroundColor: t.color.segTrack, borderRadius: 18, height: HEIGHT, padding: PAD },
  seg: { flex: 1, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  thumb: { backgroundColor: t.color.segThumb, borderRadius: 16, ...t.shadow.surface },
  label: { fontSize: 13 },
}));

/**
 * Kilo's segmented control (design brief 5.5), Android and web; iOS draws the native SwiftUI
 * one (`SegmentedControl.ios.tsx`). A white thumb on a faint track; the thumb moves with
 * `select` on Android and sits still on web. Segments are 36 high with a 44pt touch target.
 */
export function SegmentedControl<T extends string>({ segments, value, onChange, accessibilityLabel, style }: SegmentedControlProps<T>) {
  const s = useStyles();
  const index = Math.max(0, segments.findIndex((x) => x.value === value));
  return (
    <View style={[s.track, style]} accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel}>
      {native ? <Thumb index={index} count={segments.length} /> : null}
      {segments.map((x) => {
        const selected = x.value === value;
        return (
          <PressableScale
            key={x.value}
            onPress={() => onChange(x.value)}
            motion="chip"
            haptic={selected ? false : motionHaptics.select}
            hitSlop={{ top: 4, bottom: 4 }}
            accessibilityRole="radio"
            accessibilityLabel={x.label}
            accessibilityState={{ selected, checked: selected }}
            // react-native-web does not turn accessibilityState into aria-checked; say it directly.
            aria-checked={selected}
            style={[s.seg, selected && !native && s.thumb]}
          >
            <Text variant="secondary" weight={600} tone={selected ? 'ink' : 'muted'} style={s.label} numberOfLines={1}>
              {x.label}
            </Text>
          </PressableScale>
        );
      })}
    </View>
  );
}

/** The sliding thumb behind the selected segment. */
function Thumb({ index, count }: { index: number; count: number }) {
  const s = useStyles();
  const [width, setWidth] = useState(0);
  const pos = useMotionValue(index, 'select');
  const segWidth = count > 0 && width > 0 ? (width - PAD * 2) / count : 0;
  const slide = useAnimatedStyle(() => ({ transform: [{ translateX: pos.value * segWidth }] }), [segWidth]);
  const onLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (Math.abs(w - width) > 0.5) setWidth(w);
  };
  return (
    <View style={StyleSheet.absoluteFill} onLayout={onLayout} pointerEvents="none">
      {segWidth > 0 ? <Animated.View style={[s.thumb, { position: 'absolute', top: PAD, left: PAD, width: segWidth, height: HEIGHT - PAD * 2 }, slide]} /> : null}
    </View>
  );
}
