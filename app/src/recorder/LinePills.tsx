import { memo, useEffect, useRef } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import Animated, { Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { PressableScale } from '@/ui/PressableScale';
import { useColors } from '@/ui/theme';
import type { SegmentState } from './session';

const native = Platform.OS !== 'web';
const standard = Easing.bezier(0.2, 0.8, 0.2, 1);

/**
 * One pill per line (design brief 4.14): 4 high, 4 apart, filling the width; kept `accent`,
 * current white, still to do white at 25%. Each is a 44pt target that jumps to its line. When a
 * line is kept its pill fills with `accent` from left to right (200 ms, UI thread).
 */
export const LinePills = memo(function LinePills({
  states,
  keys,
  free,
  disabled,
  onJump,
}: {
  states: readonly SegmentState[];
  keys: readonly string[];
  free: boolean;
  disabled: boolean;
  onJump: (index: number) => void;
}) {
  const kept = states.filter((s) => s === 'kept').length;
  return (
    <View style={styles.row} accessibilityLabel={`${kept} ${free ? (kept === 1 ? 'clip' : 'clips') : kept === 1 ? 'line' : 'lines'} kept`}>
      {states.map((st, i) => (
        <PressableScale
          key={keys[i]}
          onPress={() => onJump(i)}
          disabled={disabled || st === 'current'}
          motion="chip"
          accessibilityRole="button"
          accessibilityLabel={`${free ? 'Clip' : 'Line'} ${i + 1}, ${st === 'kept' ? 'kept' : st === 'current' ? 'recording now' : 'to record'}${st === 'kept' ? '. Redo it' : ''}`}
          style={styles.hit}
          testID={`segment-${i}`}
        >
          <Pill state={st} />
        </PressableScale>
      ))}
    </View>
  );
});

function Pill({ state }: { state: SegmentState }) {
  const c = useColors();
  const fill = useSharedValue(state === 'kept' ? 1 : 0);
  const was = useRef(state);
  useEffect(() => {
    if (state === 'kept' && was.current !== 'kept' && native) fill.value = withTiming(1, { duration: 200, easing: standard, reduceMotion: ReduceMotion.System });
    else fill.value = state === 'kept' ? 1 : 0;
    was.current = state;
  }, [state, fill]);
  const style = useAnimatedStyle(() => ({ transform: [{ scaleX: fill.value }] }));
  return (
    <View style={[styles.pill, { backgroundColor: state === 'current' ? '#FFFFFF' : 'rgba(255,255,255,0.25)' }]}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.fill, { backgroundColor: c.accent }, style]} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 4 },
  hit: { flex: 1, height: 44, justifyContent: 'center', marginVertical: -16 },
  pill: { height: 4, borderRadius: 2, overflow: 'hidden' },
  fill: { borderRadius: 2, transformOrigin: 'left' },
});
