import type { ReactNode } from 'react';
import type { IconName } from './Icon';
import type { MenuItem } from './ActionMenu.types';

/** A button in the screen header: a glass bar button on iOS 26, an icon button elsewhere. */
export interface HeaderAction {
  /** Spoken (and on iOS, when there is room, shown) name. */
  label: string;
  icon: IconName;
  onPress: () => void;
  /** The screen's main action: the accent-filled glass button on iOS 26. */
  prominent?: boolean;
  disabled?: boolean;
  testID?: string;
  /** Makes the button open this menu instead of calling `onPress` (native header menu on iOS, Kilo's popover elsewhere). */
  menu?: MenuItem[];
  /** iOS: a text bar button showing `label` ("Save", in `accent`) instead of the symbol. Elsewhere the icon button. */
  text?: boolean;
}

/**
 * The header of a pushed screen, given to `<Screen header={…}>`. On iOS it becomes the native
 * navigation bar (Liquid Glass on iOS 26, content scrolling under it, swipe back); elsewhere it
 * is the in-content `Header` row the app always had.
 *
 * Only for route screens. Sheets and modals that render a `Screen` inside a route keep using
 * `<Header>` in their content: a native header belongs to the route.
 */
export interface ScreenHeaderConfig {
  title: string;
  /** Muted text on the right (e.g. "1 of 30"). */
  meta?: string;
  /** A control on the right. Replaces `meta`. Prefer `actions` for buttons. */
  right?: ReactNode;
  /** Buttons on the right, in order. */
  actions?: HeaderAction[];
  /**
   * Replaces Back. On iOS this also turns off the swipe-back gesture for the screen, since the
   * system gesture could not call it.
   */
  onBack?: () => void;
  /** No back button (root screens). */
  noBack?: boolean;
  /**
   * iOS sheets: the leading button is a glass `xmark` (calling `onBack`, or dismissing), and
   * swipe-to-dismiss stays on. Elsewhere the usual back button.
   */
  close?: boolean;
  /**
   * iOS: the native search field in the navigation bar (`headerSearchBarOptions`); the screen's
   * scroll view needs `contentInsetAdjustmentBehavior="automatic"`. Elsewhere the screen draws
   * its own field.
   */
  search?: { placeholder: string; onChangeText: (text: string) => void };
  /** iOS large title that collapses into the bar on scroll. Scrolling screens only. */
  large?: boolean;
  /** Title size of the in-content header (non-iOS). */
  size?: 'title' | 'titleSm';
}

export interface ScreenHeaderResult {
  /** True when the header is the native navigation bar (iOS). */
  native: boolean;
  /** What to render: `<Stack.Screen options>` on iOS, the `Header` row elsewhere. */
  element: ReactNode;
}
