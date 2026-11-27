import type { Ref } from 'react';
import type { RowModel } from './rowModels';
import type { RowActions } from './TranscriptRowView';

export interface TranscriptListHandle {
  /** Scrolls so the row sits 54pt below the top of the list (animated). */
  scrollToRow: (segmentId: string) => void;
}

export interface TranscriptListProps {
  models: readonly RowModel[];
  activeId: string | null;
  pulse: { id: string; n: number } | null;
  flash: { id: string; n: number } | null;
  actions: RowActions;
  /** Space under the last row: the floating toolbar plus 16. */
  bottomPadding: number;
  /** The creator's finger (or a fling) is moving the list, or has stopped: auto-scroll pauses for 1.5 s after. */
  onTouchState: (touching: boolean) => void;
  ref?: Ref<TranscriptListHandle>;
}

/** Where the playing row sits below the top of the list while auto-scrolling. */
export const ACTIVE_ROW_OFFSET = 54;
export const ROW_GAP = 6;
