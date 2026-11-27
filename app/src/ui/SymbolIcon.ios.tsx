import { SymbolView } from 'expo-symbols';
import { useReducedMotionSetting } from './a11y';
import { Icon } from './Icon';
import { sfSymbolFor, symbolWeightFor } from './symbols';
import { color as palette } from './tokens';
import type { SymbolIconProps } from './SymbolIcon.types';

export type { SymbolIconProps } from './SymbolIcon.types';

/** iOS: the SF Symbol from `symbols.ts`, with the line icon as the fallback should it fail to draw. */
export function SymbolIcon({ name, size = 20, color = palette.ink, strokeWidth = 2, filled, bounce }: SymbolIconProps) {
  const reduceMotion = useReducedMotionSetting();
  return (
    <SymbolView
      name={sfSymbolFor(name, filled)}
      size={size}
      tintColor={color}
      weight={symbolWeightFor(strokeWidth)}
      type="monochrome"
      animationSpec={bounce && !reduceMotion ? { effect: { type: 'bounce', direction: 'up' } } : undefined}
      fallback={<Icon name={name} size={size} color={color} strokeWidth={strokeWidth} />}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size }}
    />
  );
}
