import type { PressableProps, StyleProp, ViewStyle } from 'react-native';
import type { HapticKind } from './haptics';
import type { PressKind } from './motionPresets';

export interface PressableScaleProps extends Omit<PressableProps, 'style'> {
  /**
   * A static style. (Not a function of `pressed`: the press shows through motion.) Do not set
   * `opacity` here; use `restingOpacity`, which the pressed opacity multiplies.
   */
  style?: StyleProp<ViewStyle>;
  /** The kind of control, which sets how far it shrinks (`pressScales`). Default `button`. */
  motion?: PressKind;
  /**
   * The haptic played when the press lands (`onPress`). Default none: the brief gives presses
   * a haptic only on primary calls to action (`motionHaptics.primaryPress`) and value changes
   * (`selection`).
   */
  haptic?: HapticKind | false;
  /** Opacity when not pressed, e.g. 0.5 for a disabled control. Default 1. */
  restingOpacity?: number;
  /** A background shown at once while the finger is down (list rows: `colors.pressedRow`). */
  pressedBackgroundColor?: string;
}
