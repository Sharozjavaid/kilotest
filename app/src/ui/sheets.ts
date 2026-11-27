import { Platform } from 'react-native';
import type { NativeStackNavigationOptions } from 'expo-router/native-stack';

/**
 * Route presentations of the design brief (section 3, "Sheets versus pushed screens"), as
 * native-stack options for `<Stack.Screen options>`. On iOS they are the real UIKit sheets
 * (glass at partial detents on iOS 26, opaque at large; grabber; swipe to dismiss). Off iOS
 * they are `{}`: Android and web keep pushing the route as a full screen, which is what the
 * browser end-to-end suite drives.
 *
 * Detents are fractions of the screen height: `medium` 0.5, `large` 1.
 *
 * ```tsx
 * <Stack.Screen name="goal" options={sheet.form(['medium', 'large'])} />
 * <Stack.Screen name="broll/[id]" options={sheet.page()} />
 * ```
 *
 * A sheet's content draws no ground of its own on iOS 26 (the sheet is the material):
 * render it with `<Screen appearance=… >` only until the screen is converted, then a plain
 * View with 20pt padding and a native header (Inter 600 17) with a glass `xmark` on the trailing side.
 */
export type Detent = 'medium' | 'large' | number;

const DETENT: Record<'medium' | 'large', number> = { medium: 0.5, large: 1 };

export function detentsFor(detents: readonly Detent[]): number[] {
  return detents.map((d) => (typeof d === 'number' ? d : DETENT[d])).sort((a, b) => a - b);
}

const ios = Platform.OS === 'ios';

export const sheet = {
  /** A form sheet with detents (default medium and large), grabber visible. Goal, captions, recorder settings. */
  form(detents: readonly Detent[] = ['medium', 'large'], opts?: { initial?: number }): NativeStackNavigationOptions {
    if (!ios) return {};
    return {
      presentation: 'formSheet',
      sheetAllowedDetents: detentsFor(detents),
      sheetInitialDetentIndex: opts?.initial ?? 0,
      sheetGrabberVisible: true,
      sheetExpandsWhenScrolledToEdge: true,
      contentStyle: { backgroundColor: 'transparent' },
    };
  },
  /** A page sheet (large only): New batch, B-roll, New style, the paywall later. */
  page(): NativeStackNavigationOptions {
    if (!ios) return {};
    return { presentation: 'modal' };
  },
  /** A full-screen modal (the record group, the preview player). */
  fullScreen(opts?: { fade?: boolean }): NativeStackNavigationOptions {
    if (!ios) return {};
    return { presentation: 'fullScreenModal', animation: opts?.fade ? 'fade' : undefined };
  },
};
