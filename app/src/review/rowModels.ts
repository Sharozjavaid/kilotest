import type { TranscriptRow } from './rows';

/**
 * What one transcript row draws, joined from the EDL's views (the row, why it was cut, its
 * overlay markers), with stable identity: a row whose content did not change keeps the very
 * same object between renders, so memoised rows in a list of thousands skip re-rendering when
 * one line is tapped. Pure, unit-tested.
 */

/** A base overlay on this line, as the version being watched treats it. */
export interface RowOverlayItem {
  id: string;
  /** "B-roll", "Bold title". */
  label: string;
}

/** Overlays on the line in the version being watched (a variant): which it shows and which it leaves out. */
export interface RowOverlayInfo {
  variantLabel: string;
  shown: readonly RowOverlayItem[];
  hidden: readonly RowOverlayItem[];
}

export interface RowModel {
  row: TranscriptRow;
  /** Why a cut row was cut, in words ("Retake of the next line"); null when kept. */
  why: string | null;
  /** A cut retake that "Keep both" can bring back. */
  keepBoth: boolean;
  /** The line carries B-roll or a graphic in the version being watched. */
  hasOverlay: boolean;
  overlays: RowOverlayInfo | null;
}

export function buildRowModels(
  rows: readonly TranscriptRow[],
  why: ReadonlyMap<string, string | null>,
  keepBothIds: ReadonlySet<string>,
  marked: ReadonlySet<string>,
  overlays: ReadonlyMap<string, RowOverlayInfo>,
): RowModel[] {
  return rows.map((row) => ({
    row,
    why: row.keep ? null : (why.get(row.segmentId) ?? null),
    keepBoth: !row.keep && keepBothIds.has(row.segmentId),
    hasOverlay: marked.has(row.segmentId),
    overlays: overlays.get(row.segmentId) ?? null,
  }));
}

function sameRow(a: TranscriptRow, b: TranscriptRow): boolean {
  return (
    a.segmentId === b.segmentId &&
    a.text === b.text &&
    a.keep === b.keep &&
    a.reasonLabel === b.reasonLabel &&
    a.isSilence === b.isSilence &&
    a.durationSec === b.durationSec &&
    a.proxyStart === b.proxyStart &&
    a.proxyEnd === b.proxyEnd
  );
}

function sameItems(a: readonly RowOverlayItem[], b: readonly RowOverlayItem[]): boolean {
  return a.length === b.length && a.every((x, i) => x.id === b[i]!.id && x.label === b[i]!.label);
}

function sameOverlays(a: RowOverlayInfo | null, b: RowOverlayInfo | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.variantLabel === b.variantLabel && sameItems(a.shown, b.shown) && sameItems(a.hidden, b.hidden);
}

export function sameModel(a: RowModel, b: RowModel): boolean {
  return a.why === b.why && a.keepBoth === b.keepBoth && a.hasOverlay === b.hasOverlay && sameRow(a.row, b.row) && sameOverlays(a.overlays, b.overlays);
}

/**
 * `next`, with every model equal to the one with the same segment in `prev` replaced by that
 * earlier object. Returns `prev` itself when nothing changed at all.
 */
export function stabilizeRowModels(prev: readonly RowModel[] | null, next: readonly RowModel[]): readonly RowModel[] {
  if (!prev) return next;
  const before = new Map(prev.map((m) => [m.row.segmentId, m]));
  let changed = prev.length !== next.length;
  const out = next.map((m, i) => {
    const old = before.get(m.row.segmentId);
    if (old && sameModel(old, m)) {
      if (prev[i] !== old) changed = true;
      return old;
    }
    changed = true;
    return m;
  });
  return changed ? out : prev;
}
