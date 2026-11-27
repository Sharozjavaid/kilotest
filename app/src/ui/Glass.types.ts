import type { ViewProps } from 'react-native';
import type { GlassKind } from './glass';
import type { Appearance } from './theme';

export interface GlassProps extends ViewProps {
  /**
   * What the glass is: `bar` (toolbars, footers; radius 28, padding 8), `button` (circles and
   * capsules; radius 22, no padding), `panel` (teleprompter, recorder controls, welcome; radius
   * 28, padding 16), `toast` (radius 22, padding 12/16). Default `panel`.
   */
  kind?: GlassKind;
  /** `auto` follows the theme around it (default); `dark` for the recorder. */
  appearance?: Appearance;
  /** `accent` for the one tinted glass on a screen ("Keep, next", the Pro capsule). */
  tint?: 'accent';
  /** The native press shimmer of iOS 26 glass. For glass that is itself the button. */
  interactive?: boolean;
  /** Overrides the kind's radius (a 32 control panel, a capsule of another height). */
  radius?: number;
  /** `clear` glass for small controls over video (iOS 26); others treat it as regular. */
  variant?: 'regular' | 'clear';
}

export interface GlassGroupProps extends ViewProps {
  /** Distance at which neighbouring glass shapes merge (iOS 26). Default 8. Elsewhere a plain View. */
  spacing?: number;
}
