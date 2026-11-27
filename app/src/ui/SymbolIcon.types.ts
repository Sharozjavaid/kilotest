import type { IconName } from './Icon';

export interface SymbolIconProps {
  name: IconName;
  /** Point size. Default 20. */
  size?: number;
  color?: string;
  /** Line icon stroke; on iOS it picks the SF Symbol weight (2 = medium, 2.2 = semibold). Default 2. */
  strokeWidth?: number;
  /** The filled form, where the symbol has one (iOS). Selected tabs, toggled buttons. */
  filled?: boolean;
  /** iOS 17+ symbol effect when this changes from false to true (a bounce). Ignored under Reduce Motion. */
  bounce?: boolean;
}
