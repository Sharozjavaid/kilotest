import type { CaptionStyle, Captions } from '@kilo/edl';

/** Caption styles and labels, shared by the Review chip, its sheets and Style edit. */
export const CAPTION_STYLES: ReadonlyArray<{ value: CaptionStyle; label: string; hint: string }> = [
  { value: 'clean', label: 'Clean', hint: 'White words on a soft shadow' },
  { value: 'bold', label: 'Bold', hint: 'Big heavy words, two lines at most' },
  { value: 'karaoke', label: 'Karaoke', hint: 'Each word lights up as you say it' },
];

/** "Captions off" / "Captions: Bold". */
export function captionsLabel(c: Captions): string {
  if (!c.enabled) return 'Captions off';
  return `Captions: ${CAPTION_STYLES.find((s) => s.value === c.style)?.label ?? c.style}`;
}

export function captionHint(style: CaptionStyle): string {
  return CAPTION_STYLES.find((s) => s.value === style)?.hint ?? '';
}

export interface CaptionsSheetProps {
  open: boolean;
  captions: Captions;
  onChange: (c: Captions) => void;
  onClose: () => void;
}

