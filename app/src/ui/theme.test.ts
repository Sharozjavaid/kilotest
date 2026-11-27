import { DEFAULT_SCREEN_APPEARANCE, resolveScheme, themeFor, themes } from './theme';
import { color, darkColors, lightColors } from './tokens';
import { __setA11yForTests, prefersReducedMotion } from './a11y';
import { pressMotion } from './motionPresets';

describe('theme', () => {
  it('resolves appearances', () => {
    expect(resolveScheme('auto', 'dark')).toBe('dark');
    expect(resolveScheme('auto', 'light')).toBe('light');
    expect(resolveScheme('auto', null)).toBe('light');
    expect(resolveScheme('light', 'dark')).toBe('light');
    expect(resolveScheme('dark', 'light')).toBe('dark');
  });

  it('follows the system by default, now that every screen reads the theme', () => {
    expect(DEFAULT_SCREEN_APPEARANCE).toBe('auto');
  });

  it('returns one frozen object per scheme and contrast, so contexts and styles are stable', () => {
    expect(themeFor('light')).toBe(themes.light);
    expect(themeFor('dark')).toBe(themes.dark);
    expect(themeFor('dark', true)).toBe(themes.darkContrast);
    expect(Object.isFrozen(themes.dark)).toBe(true);
  });

  it('uses the CONTRACTS section 6 values', () => {
    expect(lightColors.ink).toBe(color.ink);
    expect(darkColors).toMatchObject({ ground: '#0A0F1A', skyTint: '#11244D', surface: 'rgba(28,34,48,0.85)', ink: '#F2F5FA', muted: '#9AA4B5', accent: '#4C7DFF', glossTop: '#3A72FF', glossBottom: '#2257F0', track: '#2A3346', hairline: 'rgba(255,255,255,0.08)', outline: 'rgba(255,255,255,0.16)', cut: '#F0875A', record: '#FF5A45' });
    expect(themes.dark.shadow.surface).toEqual({});
    expect(themes.light.shadow.surface.boxShadow).toContain('rgba(31,94,255,0.08)');
    expect(themes.dark.groundGradient.colors[0]).toBe('#11244D');
  });

  it('under Increase Contrast, muted becomes ink at 80% and hairlines become outlines', () => {
    expect(themes.lightContrast.color.muted).toBe('rgba(11,18,32,0.8)');
    expect(themes.lightContrast.color.hairline).toBe(lightColors.outline);
    expect(themes.darkContrast.color.muted).toBe('rgba(242,245,250,0.8)');
  });

  it('every dark token has a light counterpart', () => {
    expect(Object.keys(darkColors).sort()).toEqual(Object.keys(lightColors).sort());
  });
});

describe('Reduce Motion setting', () => {
  it('is read at press time and changes what a press does', () => {
    __setA11yForTests({ reduceMotion: false });
    expect(pressMotion('button', prefersReducedMotion()).scale).toBe(0.97);
    __setA11yForTests({ reduceMotion: true });
    expect(pressMotion('button', prefersReducedMotion()).scale).toBe(1);
    __setA11yForTests({ reduceMotion: false });
  });
});
