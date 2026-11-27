import { useCallback, useRef } from 'react';
import { Pressable, type GestureResponderEvent } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { prefersReducedMotion } from './a11y';
import { haptic as playHaptic } from './haptics';
import { animateTo } from './motion';
import { durations, pressMotion, type PressMotion } from './motionPresets';
import type { PressableScaleProps } from './PressableScale.types';

export type { PressableScaleProps } from './PressableScale.types';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * The one tappable surface of the app (iOS and Android): shrinks and dims under the finger on
 * a spring, springs back with a little life, and plays a haptic when the press lands. The
 * animation runs on the UI thread; the component itself never re-renders for a press.
 *
 * Reduce Motion: no change in size, only a quick dim (read at press time, so a change to the
 * setting applies on the next press).
 *
 * ```tsx
 * <PressableScale motion="card" haptic="light" onPress={open} accessibilityRole="button" accessibilityLabel="Open batch">
 *   …
 * </PressableScale>
 * ```
 */
export function PressableScale({
  motion = 'button',
  haptic = 'light',
  restingOpacity = 1,
  style,
  onPressIn,
  onPressOut,
  onPress,
  disabled,
  ...rest
}: PressableScaleProps) {
  const scale = useSharedValue(1);
  const dim = useSharedValue(1);
  const current = useRef<PressMotion | null>(null);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: restingOpacity * dim.value,
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = useCallback(
    (e: GestureResponderEvent) => {
      const m = pressMotion(motion, prefersReducedMotion());
      current.current = m;
      scale.value = animateTo(m.scale, m.pressIn);
      dim.value = animateTo(m.opacity, m.pressIn);
      onPressIn?.(e);
    },
    [motion, onPressIn, scale, dim],
  );

  const handlePressOut = useCallback(
    (e: GestureResponderEvent) => {
      const m = current.current ?? pressMotion(motion, prefersReducedMotion());
      scale.value = animateTo(1, m.pressOut);
      // Opacity eases back; a spring would overshoot past fully opaque for nothing.
      dim.value = animateTo(1, { duration: durations.fade });
      onPressOut?.(e);
    },
    [motion, onPressOut, scale, dim],
  );

  const handlePress = useCallback(
    (e: GestureResponderEvent) => {
      playHaptic(haptic);
      onPress?.(e);
    },
    [haptic, onPress],
  );

  return (
    <AnimatedPressable
      {...rest}
      disabled={disabled}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onPress={onPress ? handlePress : undefined}
      style={[style, animatedStyle]}
    />
  );
}
