import type { Edl, SegmentReason } from '@kilo/edl';

/** Silence shorter than this has no transcript row (it still shows in the scrub strip). */
export const LONG_SILENCE_SEC = 1.0;

export const REASON_LABEL: Record<Exclude<SegmentReason, 'speech'>, string> = {
  retake: 'Retake',
  false_start: 'False start',
  dead_air: 'Dead air',
  filler: 'Filler',
  off_script: 'Off script',
};

export interface TranscriptRow {
  segmentId: string;
  text: string;
  keep: boolean;
  /** Label for a cut row ("Retake"); null when kept or the reason is speech. */
  reasonLabel: string | null;
  isSilence: boolean;
  durationSec: number;
  proxyStart: number;
  proxyEnd: number;
}

export function reasonLabel(reason: SegmentReason): string | null {
  return reason === 'speech' ? null : REASON_LABEL[reason];
}

/** One row per segment that has words or is a long silence, in natural order. */
export function transcriptRows(edl: Edl, clipOffsets: Record<string, number>): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (const s of edl.segments) {
    const text = s.text.trim();
    const dur = s.end - s.start;
    const isSilence = text.length === 0;
    if (isSilence && dur < LONG_SILENCE_SEC) continue;
    const offset = clipOffsets[s.clipId] ?? 0;
    rows.push({
      segmentId: s.id,
      text: isSilence ? `Pause, ${dur.toFixed(1)}s` : text,
      keep: s.keep,
      reasonLabel: s.keep ? null : reasonLabel(s.reason) ?? 'Cut',
      isSilence,
      durationSec: dur,
      proxyStart: offset + s.start,
      proxyEnd: offset + s.end,
    });
  }
  return rows;
}

/**
 * The row to highlight for the segment under the playhead. A segment without a
 * row (a short pause) highlights the row before it.
 */
export function activeRowId(edl: Edl, rows: readonly TranscriptRow[], segmentId: string | null): string | null {
  if (!segmentId) return null;
  const withRow = new Set(rows.map((r) => r.segmentId));
  const idx = edl.segments.findIndex((s) => s.id === segmentId);
  for (let i = idx; i >= 0; i--) {
    const id = edl.segments[i]!.id;
    if (withRow.has(id)) return id;
  }
  return rows[0]?.segmentId ?? null;
}
