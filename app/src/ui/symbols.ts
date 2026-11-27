import type { SFSymbol } from 'sf-symbols-typescript';
import type { IconName } from './Icon';

/**
 * The one mapping from Kilo's icon names to SF Symbols. iOS draws the SF Symbol; every other
 * platform draws the line icon of the same name (`Icon.tsx`). `fill` is the selected or
 * emphasised form where one exists (tab bar, a toggled button).
 *
 * Every symbol here is in SF Symbols 4 or earlier, so it draws on the deployment target
 * (iOS 16.4); `symbols.test.ts` checks that.
 */
export const SF_SYMBOLS: Record<IconName, { sf: SFSymbol; fill?: SFSymbol }> = {
  settings: { sf: 'slider.horizontal.3' },
  upload: { sf: 'icloud.and.arrow.up', fill: 'icloud.and.arrow.up.fill' },
  camera: { sf: 'video', fill: 'video.fill' },
  chevronRight: { sf: 'chevron.right' },
  chevronLeft: { sf: 'chevron.left' },
  chevronUp: { sf: 'chevron.up' },
  chevronDown: { sf: 'chevron.down' },
  play: { sf: 'play.fill' },
  pause: { sf: 'pause.fill' },
  videos: { sf: 'play.rectangle.on.rectangle', fill: 'play.rectangle.on.rectangle.fill' },
  broll: { sf: 'square.on.square', fill: 'square.fill.on.square.fill' },
  styles: { sf: 'paintbrush', fill: 'paintbrush.fill' },
  user: { sf: 'person.crop.circle', fill: 'person.crop.circle.fill' },
  download: { sf: 'square.and.arrow.down', fill: 'square.and.arrow.down.fill' },
  share: { sf: 'square.and.arrow.up', fill: 'square.and.arrow.up.fill' },
  check: { sf: 'checkmark' },
  close: { sf: 'xmark' },
  plus: { sf: 'plus' },
  minus: { sf: 'minus' },
  alert: { sf: 'exclamationmark.circle', fill: 'exclamationmark.circle.fill' },
  refresh: { sf: 'arrow.clockwise' },
  merge: { sf: 'arrow.triangle.merge' },
  split: { sf: 'arrow.left.and.line.vertical.and.arrow.right' },
  pencil: { sf: 'pencil' },
  sparkle: { sf: 'sparkles' },
  wifiOff: { sf: 'wifi.slash' },
  mail: { sf: 'envelope', fill: 'envelope.fill' },
  trash: { sf: 'trash', fill: 'trash.fill' },
  flip: { sf: 'arrow.triangle.2.circlepath.camera', fill: 'arrow.triangle.2.circlepath.camera.fill' },
  list: { sf: 'list.bullet' },
  bell: { sf: 'bell', fill: 'bell.fill' },
  search: { sf: 'magnifyingglass' },
};

/** The SF Symbol for an icon, filled when asked and one exists. */
export function sfSymbolFor(name: IconName, filled = false): SFSymbol {
  const entry = SF_SYMBOLS[name];
  return filled && entry.fill ? entry.fill : entry.sf;
}

/** `{ default, selected }` for native tab bar icons. */
export function tabSymbol(name: IconName): { default: SFSymbol; selected: SFSymbol } {
  const entry = SF_SYMBOLS[name];
  return { default: entry.sf, selected: entry.fill ?? entry.sf };
}

/** SF Symbol weight that matches a line icon's stroke at the usual sizes. */
export function symbolWeightFor(strokeWidth: number): 'regular' | 'medium' | 'semibold' | 'bold' {
  if (strokeWidth >= 2.6) return 'bold';
  if (strokeWidth >= 2.2) return 'semibold';
  if (strokeWidth >= 1.8) return 'medium';
  return 'regular';
}
