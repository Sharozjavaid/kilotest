import type { RecorderPrefs, RecorderSession } from './session';

export interface RecorderSheetsProps {
  prefsOpen: boolean;
  linesOpen: boolean;
  session: RecorderSession;
  onPrefs: (p: Partial<RecorderPrefs>) => void;
  onPick: (index: number) => void;
  onClosePrefs: () => void;
  onCloseLines: () => void;
}

export const SPEED_LABELS: Record<RecorderPrefs['scrollSpeed'], string> = { 0: 'Off', 1: 'Slow', 2: 'Medium', 3: 'Fast' };
