import { DEFAULT_SETTINGS, EditSettings, MODE_PRESETS, getGraphicTheme, type SaveStyleRequest, type Style } from '@kilo/edl';

/** Saved styles (presets of edit settings). Pure, so it is unit-tested. */

export const STYLE_NAME_MAX = 40;

export function defaultStyle(styles: readonly Style[]): Style | null {
  return styles.find((s) => s.isDefault) ?? null;
}

/** What New batch and the recorder start from: the default style, or the General preset. */
export function startingSettings(styles: readonly Style[] | undefined): EditSettings {
  return (styles && defaultStyle(styles)?.settings) ?? DEFAULT_SETTINGS;
}

/** The style whose settings are exactly these, for highlighting the chooser. */
export function matchingStyle(styles: readonly Style[], settings: EditSettings): Style | null {
  const key = JSON.stringify(normalise(settings));
  return styles.find((s) => JSON.stringify(normalise(s.settings)) === key) ?? null;
}

function normalise(s: EditSettings): EditSettings {
  return EditSettings.parse(s);
}

/** "My style", then "My style 2", … avoiding names in use (case-insensitive). */
export function nextStyleName(styles: readonly Style[], base = 'My style'): string {
  const taken = new Set(styles.map((s) => s.name.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const name = `${base} ${i}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** An error to show under the name field, or null. */
export function styleNameError(name: string, styles: readonly Style[], selfId?: string): string | null {
  const t = name.trim();
  if (!t) return 'Give the style a name';
  if (t.length > STYLE_NAME_MAX) return `Up to ${STYLE_NAME_MAX} characters`;
  if (styles.some((s) => s.id !== selfId && s.name.trim().toLowerCase() === t.toLowerCase())) return 'You already have a style with this name';
  return null;
}

export interface StyleForm {
  name: string;
  settings: EditSettings;
  isDefault: boolean;
}

/** The form for a new style: from the given settings (the current ones), default if it is the first. */
export function newStyleForm(styles: readonly Style[], settings: EditSettings = startingSettings(styles)): StyleForm {
  return { name: nextStyleName(styles), settings, isDefault: styles.length === 0 };
}

export function formFromStyle(style: Style): StyleForm {
  return { name: style.name, settings: style.settings, isDefault: style.isDefault };
}

export function toSaveRequest(form: StyleForm): SaveStyleRequest {
  return { name: form.name.trim().slice(0, STYLE_NAME_MAX), settings: EditSettings.parse(form.settings), isDefault: form.isDefault };
}

/** Switching mode loads the mode's preset, keeping the graphic theme. */
export function withMode(settings: EditSettings, mode: EditSettings['mode']): EditSettings {
  return { ...MODE_PRESETS[mode].settings, graphicThemeId: settings.graphicThemeId };
}

/** Marks one style default and clears the others (what the server does on save). */
export function withDefault(styles: readonly Style[], id: string): Style[] {
  return styles.map((s) => ({ ...s, isDefault: s.id === id }));
}

const CAPTION_LABEL = { clean: 'Clean', bold: 'Bold', karaoke: 'Karaoke' } as const;

/** "UGC ad · Tight · Bold captions · Pop graphics · 3 hooks". */
export function settingsSummary(s: EditSettings): string {
  const parts = [MODE_PRESETS[s.mode].label, s.pacing === 'tight' ? 'Tight' : 'Natural'];
  parts.push(s.captions ? `${CAPTION_LABEL[s.captionStyle]} captions` : 'No captions');
  parts.push(s.graphics ? `${getGraphicTheme(s.graphicThemeId).name} graphics` : 'No graphics');
  if (s.hookVariations > 1) parts.push(`${s.hookVariations} hooks`);
  return parts.join(' · ');
}
