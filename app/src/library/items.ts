import type { VideoSummary } from '@kilo/edl';
import { finishedSubtitle, reviewSubtitle, statusLabel } from '@/lib/format';

/**
 * The library's rows, pure so it is unit-tested: videos in batch order with a header
 * before each batch, fixed heights so the virtualised list can place any row without
 * measuring, and where a tap goes.
 */

export const ROW_HEIGHT = 68;
export const HEADER_HEIGHT = 44;

export type LibraryItem =
  | { kind: 'batch'; key: string; batchId: string; createdAt: string }
  | { kind: 'video'; key: string; video: VideoSummary };

/** Videos (already in batch order) with a header row wherever the batch changes. */
export function libraryItems(videos: readonly VideoSummary[]): LibraryItem[] {
  const out: LibraryItem[] = [];
  let batch: string | null = null;
  for (const v of videos) {
    if (v.batchId !== batch) {
      batch = v.batchId;
      out.push({ kind: 'batch', key: `batch:${v.batchId}`, batchId: v.batchId, createdAt: v.createdAt });
    }
    out.push({ kind: 'video', key: v.id, video: v });
  }
  return out;
}

export interface ItemLayout {
  length: number;
  offset: number;
  index: number;
}

/** Offsets of every row, for FlatList's getItemLayout. */
export function itemLayouts(items: readonly LibraryItem[]): ItemLayout[] {
  let offset = 0;
  return items.map((it, index) => {
    const length = it.kind === 'batch' ? HEADER_HEIGHT : ROW_HEIGHT;
    const l = { length, offset, index };
    offset += length;
    return l;
  });
}

/** Where a row leads: the edit to review, the finished video, or its batch while it is not ready. */
export function libraryHref(v: Pick<VideoSummary, 'id' | 'batchId' | 'status'>): string {
  if (v.status === 'ready_for_review') return `/review/${v.id}`;
  if (v.status === 'rendering' || v.status === 'done') return `/export/${v.id}`;
  return `/batch/${v.batchId}`;
}

/** The muted line under a title. */
export function librarySubtitle(v: VideoSummary): string {
  if (v.status === 'ready_for_review') return reviewSubtitle(v);
  if (v.status === 'rendering' || v.status === 'done') return finishedSubtitle(v);
  if (v.status === 'failed') return "Couldn't edit · Open its batch to retry";
  return statusLabel(v.status);
}

/** "Batch started 27 Nov, 14:05". */
export function batchHeading(createdAt: string, locale?: string): string {
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return 'Batch';
  const day = d.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  return `Batch started ${day}, ${time}`;
}
