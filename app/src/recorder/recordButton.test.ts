import { phaseHaptic, recordButtonState, recordMarkShape, teleprompterOffset, RECORD_INNER, RECORD_SQUARE, RECORD_SQUARE_RADIUS } from './recordButton';

describe('record button', () => {
  it('says what it does and morphs while recording', () => {
    expect(recordButtonState('idle', false)).toMatchObject({ label: 'Record this line', mark: 'circle', morph: 0 });
    expect(recordButtonState('idle', true)).toMatchObject({ label: 'Record this line again', mark: 'again', morph: 0 });
    expect(recordButtonState('countdown', false)).toMatchObject({ label: 'Cancel countdown', mark: 'circle' });
    expect(recordButtonState('recording', true)).toMatchObject({ label: 'Stop recording', mark: 'square', morph: 1, disabled: false });
    expect(recordButtonState('saving', false)).toMatchObject({ mark: 'busy', disabled: true });
  });

  it('plays medium when recording starts and light when it stops, nothing else', () => {
    expect(phaseHaptic('idle', 'recording')).toBe('medium');
    expect(phaseHaptic('countdown', 'recording')).toBe('medium');
    expect(phaseHaptic('recording', 'saving')).toBe('light');
    expect(phaseHaptic('saving', 'idle')).toBeNull();
    expect(phaseHaptic('idle', 'countdown')).toBeNull();
  });

  it('goes from the 62pt circle to a 28pt square with 8pt corners', () => {
    expect(recordMarkShape(0)).toEqual({ scale: 1, radius: RECORD_INNER / 2 });
    const end = recordMarkShape(1);
    expect(end.scale * RECORD_INNER).toBeCloseTo(RECORD_SQUARE, 6);
    expect(end.radius * end.scale).toBeCloseTo(RECORD_SQUARE_RADIUS, 6);
    // A spring's overshoot is clamped.
    expect(recordMarkShape(1.2)).toEqual(end);
  });
});

describe('teleprompter scroll', () => {
  it('holds still for 1.2 s, then rolls at the speed, up to the end', () => {
    expect(teleprompterOffset(1000, 24, 100)).toBe(0);
    expect(teleprompterOffset(2200, 24, 100)).toBeCloseTo(24, 6);
    expect(teleprompterOffset(60_000, 24, 100)).toBe(100);
    expect(teleprompterOffset(5000, 0, 100)).toBe(0);
    expect(teleprompterOffset(5000, 24, 0)).toBe(0);
  });
});
