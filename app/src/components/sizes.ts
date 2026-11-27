import { Platform } from 'react-native';

/**
 * A primary button's height in a footer: 48 inside the floating glass bar (design brief 5.3, the
 * bar's inner radius 24 against its 28), 56 where the footer stays in the flow (web).
 */
export const FOOTER_BUTTON = Platform.OS === 'web' ? 56 : 48;

/** A video row's fixed height (design brief 5.8), so a virtualised list can place any row without measuring. */
export const VIDEO_ROW_HEIGHT = 76;
