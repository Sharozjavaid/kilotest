import type { ColorValue, ViewProps } from 'react-native';

export interface GlassSurfaceProps extends ViewProps {
  /** Corner radius. Default `radius.card` (20); use half the height for a capsule. */
  radius?: number;
  /**
   * Tint of the glass. Liquid Glass takes it as its tint colour (keep it light: the system
   * picks a legible foreground over it); elsewhere it is laid over the blur at low opacity.
   */
  tint?: ColorValue;
  /**
   * Liquid Glass reacts to touch (it brightens and flexes under the finger). For glass that is
   * itself the button. iOS 26+ only; ignored elsewhere.
   */
  interactive?: boolean;
  /** `regular` (default) frosts what is behind; `clear` is for glass over media (the player, the camera). */
  variant?: 'regular' | 'clear';
  /** The hairline border of the fallback surface. Default true. Liquid Glass draws its own edge. */
  bordered?: boolean;
  /** The soft blue `shadow.surface` of the fallback surface. Default false. */
  elevated?: boolean;
}

export interface GlassGroupProps extends ViewProps {
  /**
   * Distance at which neighbouring glass shapes start to merge into one (iOS 26+). Default 12.
   * Elsewhere the group is a plain View.
   */
  spacing?: number;
}
