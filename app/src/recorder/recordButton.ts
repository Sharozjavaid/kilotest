import type { HapticKind } from '@/ui/haptics';
import { motionHaptics } from '@/ui/motionPresets';

/**
 * The recorder's record button (design brief 4.14), as pure state so it is unit-tested:
 * what it says, which shape its inner mark takes, and the haptic each change plays.
 */
export type RecorderPhase = 'idle' | 'countdown' | 'recording' | 'saving';

/** `circle`: ready to record. `square`: recording (the 28pt rounded square). `again`: a take waits ("Record again"). `busy`: saving the take. */
export type RecordMark = 'circle' | 'square' | 'again' | 'busy';

export interface RecordButtonState {
  label: string;
  mark: RecordMark;
  /** 0 for the circle, 1 for the rounded square: the morph's target. */
  morph: 0 | 1;
  disabled: boolean;
}

export function recordButtonState(phase: RecorderPhase, hasPendingTake: boolean): RecordButtonState {
  switch (phase) {
    case 'recording':
      return { label: 'Stop recording', mark: 'square', morph: 1, disabled: false };
    case 'saving':
      return { label: 'Saving the take', mark: 'busy', morph: 1, disabled: true };
    case 'countdown':
      return { label: 'Cancel countdown', mark: 'circle', morph: 0, disabled: false };
    case 'idle':
      return hasPendingTake
        ? { label: 'Record this line again', mark: 'again', morph: 0, disabled: false }
        : { label: 'Record this line', mark: 'circle', morph: 0, disabled: false };
  }
}

/** The haptic for a phase change: recording starts (medium), recording stops (light), each countdown tick. */
export function phaseHaptic(from: RecorderPhase, to: RecorderPhase): HapticKind | null {
  if (to === 'recording' && from !== 'recording') return motionHaptics.recordStart;
  if (from === 'recording' && to !== 'recording') return motionHaptics.recordStop;
  return null;
}

/** Shape of the inner mark for a morph value: scale from the 62pt circle and corner radius. */
export const RECORD_OUTER = 76;
export const RECORD_INNER = 62;
export const RECORD_SQUARE = 28;
export const RECORD_SQUARE_RADIUS = 8;

export function recordMarkShape(morph: number): { scale: number; radius: number } {
  'worklet';
  const m = Math.min(1, Math.max(0, morph));
  const endScale = RECORD_SQUARE / RECORD_INNER;
  const scale = 1 - m * (1 - endScale);
  // The radius is drawn on the unscaled 62pt view, so it is divided by the scale it ends at.
  const endRadius = RECORD_SQUARE_RADIUS / endScale;
  const radius = RECORD_INNER / 2 - m * (RECORD_INNER / 2 - endRadius);
  return { scale, radius };
}

/**
 * The teleprompter's auto-scroll: still for the first `holdMs` of a take, then `pxPerSec`,
 * never past the end. Pure (a worklet: it runs in the frame callback).
 */
export function teleprompterOffset(elapsedMs: number, pxPerSec: number, maxScroll: number, holdMs = 1200): number {
  'worklet';
  if (pxPerSec <= 0 || maxScroll <= 0 || elapsedMs <= holdMs) return 0;
  return Math.min(maxScroll, ((elapsedMs - holdMs) / 1000) * pxPerSec);
}
