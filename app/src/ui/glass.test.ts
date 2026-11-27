import { Platform } from 'react-native';
import { glassFallback, glassKinds, glassModeFor, hasLiquidGlass, resetGlassCache } from './glass';

jest.mock('expo-glass-effect', () => ({ isLiquidGlassAvailable: jest.fn(() => true), isGlassEffectAPIAvailable: jest.fn(() => true) }));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const glassModule = require('expo-glass-effect') as { isLiquidGlassAvailable: jest.Mock; isGlassEffectAPIAvailable: jest.Mock };

function withOS<T>(os: typeof Platform.OS, fn: () => T): T {
  const prev = Platform.OS;
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(Platform, 'OS', { value: prev, configurable: true });
  }
}

describe('glass fallback ladder (design brief section 7)', () => {
  it('picks Liquid Glass on iOS 26, blur on older iOS, CSS blur on web, solid on Android', () => {
    expect(glassModeFor({ os: 'ios', liquidGlass: true, reduceTransparency: false })).toBe('liquid');
    expect(glassModeFor({ os: 'ios', liquidGlass: false, reduceTransparency: false })).toBe('blur');
    expect(glassModeFor({ os: 'web', liquidGlass: false, reduceTransparency: false })).toBe('css');
    expect(glassModeFor({ os: 'android', liquidGlass: false, reduceTransparency: false })).toBe('solid');
  });

  it('is solid everywhere under Reduce Transparency', () => {
    for (const os of ['ios', 'android', 'web'] as const) {
      expect(glassModeFor({ os, liquidGlass: os === 'ios', reduceTransparency: true })).toBe('solid');
    }
  });

  it('fills each fallback as the brief says', () => {
    expect(glassFallback('blur', 'light', 'ios')).toEqual({ backgroundColor: 'rgba(255,255,255,0.55)', blurTint: 'systemThinMaterialLight', shadow: true, elevation: 0 });
    expect(glassFallback('blur', 'dark', 'ios').blurTint).toBe('systemThinMaterialDark');
    expect(glassFallback('solid', 'light', 'android')).toMatchObject({ backgroundColor: 'rgba(255,255,255,0.94)', elevation: 2 });
    expect(glassFallback('solid', 'dark', 'android').backgroundColor).toBe('rgba(43,48,56,0.9)');
    expect(glassFallback('css', 'light', 'web')).toMatchObject({ backgroundColor: 'rgba(255,255,255,0.72)', backdropFilter: 'blur(20px) saturate(180%)' });
  });

  it('keeps one size per kind on every platform', () => {
    expect(glassKinds.bar).toEqual({ radius: 28, paddingVertical: 8, paddingHorizontal: 8 });
    expect(glassKinds.button.radius).toBe(22);
    expect(glassKinds.toast).toEqual({ radius: 22, paddingVertical: 12, paddingHorizontal: 16 });
  });

  describe('hasLiquidGlass', () => {
    beforeEach(() => {
      resetGlassCache();
      glassModule.isLiquidGlassAvailable.mockReturnValue(true);
      glassModule.isGlassEffectAPIAvailable.mockReturnValue(true);
    });

    it('is true on iOS when both native checks pass', () => {
      expect(withOS('ios', hasLiquidGlass)).toBe(true);
    });

    it('is false when the glass API is missing (some iOS 26 betas) or the module throws', () => {
      glassModule.isGlassEffectAPIAvailable.mockReturnValue(false);
      expect(withOS('ios', hasLiquidGlass)).toBe(false);
      resetGlassCache();
      glassModule.isLiquidGlassAvailable.mockImplementation(() => {
        throw new Error('no native module');
      });
      expect(withOS('ios', hasLiquidGlass)).toBe(false);
    });

    it('is false on Android and web without asking the native module', () => {
      glassModule.isLiquidGlassAvailable.mockClear();
      expect(withOS('android', hasLiquidGlass)).toBe(false);
      resetGlassCache();
      expect(withOS('web', hasLiquidGlass)).toBe(false);
      expect(glassModule.isLiquidGlassAvailable).not.toHaveBeenCalled();
    });
  });
});
