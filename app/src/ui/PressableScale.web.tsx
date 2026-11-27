import { Pressable } from 'react-native';
import { pressOpacities } from './motionPresets';
import type { PressableScaleProps } from './PressableScale.types';

export type { PressableScaleProps } from './PressableScale.types';

/**
 * Web: the press shows as the same opacity change the controls always had, and no haptics.
 * The browser end-to-end suite drives this build, so it stays as it was.
 */
export function PressableScale({ motion = 'button', haptic: _haptic, restingOpacity = 1, pressedBackgroundColor: _bg, style, disabled, ...rest }: PressableScaleProps) {
  return (
    <Pressable
      {...rest}
      disabled={disabled}
      style={({ pressed }) => [style, { opacity: restingOpacity * (pressed && !disabled ? pressOpacities[motion] : 1) }]}
    />
  );
}
