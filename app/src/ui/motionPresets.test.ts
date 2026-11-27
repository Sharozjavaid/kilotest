import { motionConfig, motionEnabled, motionHaptics, pressMotion, springs, staggerDelay, timings, type MotionName } from './motionPresets';

const ALL: MotionName[] = ['press', 'select', 'cutToggle', 'appear', 'listInsert', 'listRemove', 'progress', 'success', 'toast', 'sheetIn', 'record', 'countdown', 'shimmer', 'shake'];

describe('motion presets (design brief section 6)', () => {
  it('has the spec values', () => {
    expect(springs.press).toEqual({ mass: 0.5, damping: 18, stiffness: 420 });
    expect(springs.select).toEqual({ mass: 0.8, damping: 22, stiffness: 320 });
    expect(springs.list).toEqual({ mass: 0.7, damping: 20, stiffness: 260 });
    expect(springs.success).toEqual({ mass: 0.6, damping: 12, stiffness: 260 });
    expect(springs.toast).toEqual({ mass: 0.7, damping: 24, stiffness: 300 });
    expect(springs.sheetIn).toEqual({ mass: 0.9, damping: 26, stiffness: 240 });
    expect(springs.record).toEqual({ mass: 0.6, damping: 16, stiffness: 300 });
    expect(timings.appear).toEqual({ duration: 240, easing: 'standard' });
    expect(timings.progress).toEqual({ duration: 450, easing: 'progress' });
    expect(timings.shimmer.duration).toBe(1400);
  });

  it('presses scale 0.97 for buttons and 0.98 for cards and rows, without dimming', () => {
    expect(pressMotion('button', false)).toMatchObject({ scale: 0.97, opacity: 1, pressIn: springs.press });
    expect(pressMotion('card', false).scale).toBe(0.98);
    expect(pressMotion('row', false).scale).toBe(0.98);
  });

  it('under Reduce Motion, a press does not scale: it cross-fades in 150 ms or less', () => {
    for (const kind of ['button', 'icon', 'chip', 'card', 'row', 'tile'] as const) {
      const m = pressMotion(kind, true);
      expect(m.scale).toBe(1);
      expect(m.opacity).toBeLessThan(1);
      expect('stiffness' in m.pressOut).toBe(false);
      expect((m.pressOut as { duration: number }).duration).toBeLessThanOrEqual(150);
    }
  });

  it('under Reduce Motion, no motion springs, fades stay at 150 ms or less, progress jumps', () => {
    for (const name of ALL) {
      const c = motionConfig(name, true);
      expect('stiffness' in c).toBe(false);
      if (name !== 'cutToggle') expect((c as { duration: number }).duration).toBeLessThanOrEqual(150);
    }
    expect(motionConfig('progress', true)).toEqual({ duration: 0 });
    expect(motionConfig('record', true)).toEqual({ duration: 0 });
  });

  it('without Reduce Motion each motion uses its spec config', () => {
    expect(motionConfig('select', false)).toBe(springs.select);
    expect(motionConfig('listInsert', false)).toBe(springs.list);
    expect(motionConfig('progress', false)).toBe(timings.progress);
  });

  it('switches stagger, shimmer, pop and shake off under Reduce Motion', () => {
    for (const n of ['stagger', 'shimmer', 'pop', 'shake'] as const) {
      expect(motionEnabled(n, false)).toBe(true);
      expect(motionEnabled(n, true)).toBe(false);
    }
  });

  it('staggers 35 ms apart, first eight only, none under Reduce Motion', () => {
    expect(staggerDelay(0, false)).toBe(0);
    expect(staggerDelay(1, false)).toBe(35);
    expect(staggerDelay(8, false)).toBe(280);
    expect(staggerDelay(20, false)).toBe(280);
    expect(staggerDelay(5, true)).toBe(0);
  });

  it('maps haptics as the spec does', () => {
    expect(motionHaptics).toMatchObject({ primaryPress: 'light', select: 'selection', cut: 'light', restore: 'soft', success: 'success', recordStart: 'medium', recordStop: 'light', shake: 'error' });
  });
});
