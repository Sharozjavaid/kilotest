import { memo, useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { PressableScale } from '@/ui/PressableScale';
import { SymbolIcon } from '@/ui/SymbolIcon';
import { prefersReducedMotion } from '@/ui/a11y';
import { springs } from '@/ui/motionPresets';
import { useColors } from '@/ui/theme';
import { RECORD_INNER, RECORD_OUTER, recordButtonState, recordMarkShape, type RecorderPhase } from './recordButton';

/**
 * The 76pt record button (design brief 4.14): a 4pt white ring around a 62pt `record` circle
 * that morphs into a 28pt rounded square while recording, on the UI thread (`record` spring;
 * instant under Reduce Motion). After a take it shows "Record again". The screen plays the
 * start and stop haptics.
 */
export const RecordButton = memo(function RecordButton({ phase, pending, onPress }: { phase: RecorderPhase; pending: boolean; onPress: () => void }) {
  const c = useColors();
  const st = recordButtonState(phase, pending);
  const morph = useSharedValue<number>(st.morph);
  useEffect(() => {
    morph.value = prefersReducedMotion() ? st.morph : withSpring(st.morph, { ...springs.record, reduceMotion: ReduceMotion.System });
  }, [st.morph, morph]);
  const inner = useAnimatedStyle(() => {
    const { scale, radius } = recordMarkShape(morph.value);
    return { transform: [{ scale }], borderRadius: radius };
  });
  return (
    <PressableScale onPress={onPress} disabled={st.disabled} motion="button" accessibilityRole="button" accessibilityLabel={st.label} accessibilityState={{ disabled: st.disabled, busy: st.mark === 'busy' }} style={styles.outer} testID="record">
      <Animated.View style={[styles.inner, { backgroundColor: c.record }, inner]} />
      {st.mark === 'again' ? (
        <View style={styles.center} pointerEvents="none">
          <SymbolIcon name="refresh" size={20} strokeWidth={2.4} color="#FFFFFF" />
        </View>
      ) : null}
      {st.mark === 'busy' ? (
        <View style={styles.center} pointerEvents="none">
          <ActivityIndicator color="#FFFFFF" />
        </View>
      ) : null}
    </PressableScale>
  );
});

const styles = StyleSheet.create({
  outer: { width: RECORD_OUTER, height: RECORD_OUTER, borderRadius: RECORD_OUTER / 2, borderWidth: 4, borderColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  inner: { width: RECORD_INNER, height: RECORD_INNER },
  center: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
});
