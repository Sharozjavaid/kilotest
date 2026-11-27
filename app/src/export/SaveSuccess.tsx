import { useEffect } from 'react';
import { Platform, View } from 'react-native';
import Animated, { Easing, ReduceMotion, useAnimatedProps, useAnimatedStyle, useSharedValue, withDelay, withSequence, withSpring, withTiming } from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';
import { Glass, distances, prefersReducedMotion, springs, timings, useColors, useMotionValue } from '@/ui';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedPath = Animated.createAnimatedComponent(Path);

const SIZE = 64;
const RING = 44;
const STROKE = 3;
const R = (RING - STROKE) / 2;
const CIRC = 2 * Math.PI * R;
/** The check inside the ring, on the ring's 44 grid. */
const CHECK = 'M14 22.5l5.5 5.5L30 17';
const CHECK_LEN = 24;
const standard = Easing.bezier(0.2, 0.8, 0.2, 1);

/** How long the whole moment takes before the pop lands (ms), for the haptic and toast to meet it. */
export function successDelay(reduced: boolean): number {
  return reduced ? 0 : timings.progress.duration + timings.successCheck.duration;
}

/**
 * The Export screen's one success moment (design brief 4.7, motion `success`): while the versions
 * save, a ring fills; when the last one is in, the ring closes, the check draws (260 ms), then the
 * badge pops 1 to 1.06 to 1. All on the UI thread. Under Reduce Motion the ring jumps, the check
 * shows at once and there is no pop. Web shows the end state.
 */
export function SaveSuccess({ progress, done }: { progress: number; done: boolean }) {
  const c = useColors();
  const ring = useMotionValue(done ? 1 : progress, 'progress');
  const check = useSharedValue(0);
  const scale = useSharedValue(1);

  useEffect(() => {
    if (!done) return;
    const reduced = prefersReducedMotion() || Platform.OS === 'web';
    if (reduced) {
      check.value = 1;
      return;
    }
    const wait = timings.progress.duration;
    check.value = withDelay(wait, withTiming(1, { duration: timings.successCheck.duration, easing: standard, reduceMotion: ReduceMotion.System }));
    scale.value = withDelay(
      wait + timings.successCheck.duration,
      withSequence(withTiming(distances.successPop, { duration: 90, easing: standard }), withSpring(1, { ...springs.success, reduceMotion: ReduceMotion.System })),
    );
  }, [done, check, scale]);

  const arc = useAnimatedProps(() => ({ strokeDashoffset: CIRC * (1 - ring.value) }));
  const tick = useAnimatedProps(() => ({ strokeDashoffset: CHECK_LEN * (1 - check.value) }));
  const pop = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Animated.View style={pop} accessibilityRole={done ? 'image' : 'progressbar'} accessibilityLabel={done ? 'Saved' : `Saving, ${Math.round(progress * 100)}%`}>
      <Glass kind="button" variant="clear" appearance="dark" radius={SIZE / 2} style={{ width: SIZE, height: SIZE, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: RING, height: RING, transform: [{ rotate: '-90deg' }] }}>
          <Svg width={RING} height={RING}>
            <Circle cx={RING / 2} cy={RING / 2} r={R} stroke="rgba(255,255,255,0.3)" strokeWidth={STROKE} fill="none" />
            <AnimatedCircle cx={RING / 2} cy={RING / 2} r={R} stroke={c.accent} strokeWidth={STROKE} strokeLinecap="round" fill="none" strokeDasharray={`${CIRC} ${CIRC}`} animatedProps={arc} />
          </Svg>
        </View>
        <View style={{ position: 'absolute', width: RING, height: RING }}>
          <Svg width={RING} height={RING}>
            <AnimatedPath d={CHECK} stroke="#FFFFFF" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" fill="none" strokeDasharray={`${CHECK_LEN} ${CHECK_LEN}`} animatedProps={tick} />
          </Svg>
        </View>
      </Glass>
    </Animated.View>
  );
}
