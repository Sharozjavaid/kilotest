import { Platform } from 'react-native';

jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  performAndroidHapticsAsync: jest.fn(() => Promise.resolve()),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Haptics = require('expo-haptics') as Record<string, jest.Mock>;

function withOS<T>(os: typeof Platform.OS, fn: () => T): T {
  const prev = Platform.OS;
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(Platform, 'OS', { value: prev, configurable: true });
  }
}

describe('haptics', () => {
  beforeEach(() => Object.values(Haptics).forEach((f) => f.mockClear()));

  it('maps each kind per platform, and to nothing on web', () => {
    const { hapticCallFor } = jest.requireActual('./haptics') as typeof import('./haptics');
    expect(hapticCallFor('selection', 'ios')).toEqual({ fn: 'selectionAsync' });
    expect(hapticCallFor('light', 'ios')).toEqual({ fn: 'impactAsync', arg: 'light' });
    expect(hapticCallFor('soft', 'ios')).toEqual({ fn: 'impactAsync', arg: 'soft' });
    expect(hapticCallFor('success', 'ios')).toEqual({ fn: 'notificationAsync', arg: 'success' });
    expect(hapticCallFor('error', 'android')).toEqual({ fn: 'performAndroidHapticsAsync', arg: 'reject' });
    for (const k of ['selection', 'light', 'medium', 'soft', 'rigid', 'success', 'warning', 'error'] as const) {
      expect(hapticCallFor(k, 'web')).toBeNull();
    }
  });

  it('does nothing on web', () => {
    const { haptic, haptics } = jest.requireActual('./haptics') as typeof import('./haptics');
    withOS('web', () => {
      haptic('success');
      haptics.selection();
      haptics.medium();
    });
    Object.values(Haptics).forEach((f) => expect(f).not.toHaveBeenCalled());
  });

  it('plays the iOS call on iOS and never throws', () => {
    const { haptic } = jest.requireActual('./haptics') as typeof import('./haptics');
    withOS('ios', () => {
      haptic('light');
      haptic('success');
      haptic(false);
    });
    expect(Haptics.impactAsync).toHaveBeenCalledWith('light');
    expect(Haptics.notificationAsync).toHaveBeenCalledWith('success');
    Haptics.selectionAsync!.mockImplementationOnce(() => {
      throw new Error('no engine');
    });
    expect(() => withOS('ios', () => haptic('selection'))).not.toThrow();
  });

  it('can be switched off', () => {
    const { haptic, setHapticsEnabled } = jest.requireActual('./haptics') as typeof import('./haptics');
    setHapticsEnabled(false);
    withOS('ios', () => haptic('light'));
    setHapticsEnabled(true);
    expect(Haptics.impactAsync).not.toHaveBeenCalled();
  });
});
