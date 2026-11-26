import { DEFAULT_SETTINGS, MODE_PRESETS, SaveStyleRequest, type Style } from '@kilo/edl';
import {
  matchingStyle,
  newStyleForm,
  nextStyleName,
  settingsSummary,
  startingSettings,
  styleNameError,
  toSaveRequest,
  withDefault,
  withMode,
} from './styleForm';

const ugc: Style = { id: 's1', name: 'Ads', settings: MODE_PRESETS.ugc_ad.settings, isDefault: false };
const shop: Style = { id: 's2', name: 'Shop', settings: { ...MODE_PRESETS.tiktok_shop.settings, graphicThemeId: 'pop', captions: true, captionStyle: 'bold' }, isDefault: true };

describe('style defaults', () => {
  it('starts from the default style, or the General preset when there is none', () => {
    expect(startingSettings([ugc, shop])).toEqual(shop.settings);
    expect(startingSettings([ugc])).toEqual(DEFAULT_SETTINGS);
    expect(startingSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it('makes the first style the default and names new ones without clashes', () => {
    expect(newStyleForm([])).toEqual({ name: 'My style', settings: DEFAULT_SETTINGS, isDefault: true });
    const taken = [{ ...ugc, name: 'My style' }, { ...shop, name: 'my style 2' }];
    expect(nextStyleName(taken)).toBe('My style 3');
    expect(newStyleForm(taken, ugc.settings)).toMatchObject({ name: 'My style 3', settings: ugc.settings, isDefault: false });
  });

  it('marks exactly one default', () => {
    expect(withDefault([ugc, shop], 's1').map((s) => s.isDefault)).toEqual([true, false]);
  });

  it('finds the style matching the current settings', () => {
    expect(matchingStyle([ugc, shop], MODE_PRESETS.ugc_ad.settings)?.id).toBe('s1');
    expect(matchingStyle([ugc, shop], { ...MODE_PRESETS.ugc_ad.settings, captions: true })).toBeNull();
  });
});

describe('style form', () => {
  it('validates the name', () => {
    expect(styleNameError('  ', [])).toBe('Give the style a name');
    expect(styleNameError('x'.repeat(41), [])).toBe('Up to 40 characters');
    expect(styleNameError('ads', [ugc])).toBe('You already have a style with this name');
    expect(styleNameError('Ads', [ugc], 's1')).toBeNull();
  });

  it('builds a request the server accepts', () => {
    const req = toSaveRequest({ name: '  Weekend  ', settings: withMode(shop.settings, 'general'), isDefault: true });
    expect(SaveStyleRequest.safeParse(req).success).toBe(true);
    expect(req.name).toBe('Weekend');
    // Switching mode loads the preset but keeps the graphic theme.
    expect(req.settings).toEqual({ ...MODE_PRESETS.general.settings, graphicThemeId: 'pop' });
  });

  it('summarises settings in a line', () => {
    expect(settingsSummary(shop.settings)).toBe('TikTok Shop · Tight · Bold captions · Pop graphics · 3 hooks');
    expect(settingsSummary(DEFAULT_SETTINGS)).toBe('General · Natural · No captions · Clean graphics');
  });
});
