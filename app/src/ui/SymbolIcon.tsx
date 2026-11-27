import { Icon } from './Icon';
import type { SymbolIconProps } from './SymbolIcon.types';

export type { SymbolIconProps } from './SymbolIcon.types';

/**
 * An icon by Kilo name: the SF Symbol on iOS (`SymbolIcon.ios.tsx`), the line icon of the same
 * name everywhere else (this file). Decorative: the control holding it carries the label.
 *
 * ```tsx
 * <SymbolIcon name="upload" size={20} color={color.white} strokeWidth={2.2} />
 * ```
 */
export function SymbolIcon({ name, size = 20, color, strokeWidth = 2 }: SymbolIconProps) {
  return <Icon name={name} size={size} color={color} strokeWidth={strokeWidth} />;
}
