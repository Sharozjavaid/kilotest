import { useCallback, useRef } from 'react';
import { Pressable, type GestureResponderEvent } from 'react-native';
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { prefersReducedMotion } from './a11y';
import { haptic as playHaptic } from './haptics';
import { animateTo } from './motion';
import { pressMotion, type PressMotion } from './motionPresets';
import type { PressableScaleProps } from './PressableScale.types';

export type { PressableScaleProps } from './PressableScale.types';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * The one tappable surface of the app (iOS and Android): the `press` motion of the brief.
 * Shrinks to 0.97 (buttons) or 0.98 (cards, rows) on a spring under the finger and springs
 * back on release; the haptic, if any, plays when the press lands (`onPress`), never on
 * press-in. The animation runs on the UI thread and the component never re-renders for a
 * press.
 *
 * Reduce Motion: no change in size, only a 150 ms cross-fade to the old pressed opacity and
 * back (read at press time, so a change to the setting applies on the next press).
 *
 * ```tsx
 * <PressableScale motion="card" onPress={open} accessibilityRole="button" accessibilityLabel="Open batch">
 *   …
 * </PressableScale>
 * ```
 */
export function PressableScale({
  motion = 'button',
  haptic = false,
  restingOpacity = 1,
  pressedBackgroundColor,
  style,
  onPressIn,
  onPressOut,
  onPress,
  disabled,
  ...rest
}: PressableScaleProps) {
  const scale = useSharedValue(1);
  const dim = useSharedValue(1);
  const down = useSharedValue(0);
  const current = useRef<{ m: PressMotion; rm: ReduceMotion } | null>(null);

  const animatedStyle = useAnimatedStyle(() => {
    const s: { opacity: number; transform: { scale: number }[]; backgroundColor?: string } = {
      opacity: restingOpacity * dim.value,
      transform: [{ scale: scale.value }],
    };
    if (pressedBackgroundColor) s.backgroundColor = down.value ? pressedBackgroundColor : 'transparent';
    return s;
  }, [restingOpacity, pressedBackgroundColor]);

  const handlePressIn = useCallback(
    (e: GestureResponderEvent) => {
      const reduced = prefersReducedMotion();
      const m = pressMotion(motion, reduced);
      const rm = reduced ? ReduceMotion.Never : ReduceMotion.System;
      current.current = { m, rm };
      down.value = 1;
      scale.value = animateTo(m.scale, m.pressIn, rm);
      dim.value = animateTo(m.opacity, m.pressIn, rm);
      onPressIn?.(e);
    },
    [motion, onPressIn, scale, dim, down],
  );

  const handlePressOut = useCallback(
    (e: GestureResponderEvent) => {
      const { m, rm } = current.current ?? { m: pressMotion(motion, prefersReducedMotion()), rm: ReduceMotion.System };
      down.value = 0;
      scale.value = animateTo(1, m.pressOut, rm);
      dim.value = animateTo(1, m.pressOut, rm);
      onPressOut?.(e);
    },
    [motion, onPressOut, scale, dim, down],
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
