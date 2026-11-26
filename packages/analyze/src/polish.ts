import type { ClipInfo, EditSettings, Segment } from '@kilo/edl';
import { PACING_PARAMS } from '@kilo/edl';

/** Minimum length of both sides of a crossfade, so the blend never eats a short line. */
const CROSSFADE_MIN_SEC = 1.0;

/**
 * Punch-in and transitions. With zoomAndTransitions on, the zoom flips between 1 and
 * the pacing's punch-in scale at each jump cut inside a clip (alternate kept
 * segments after a cut), and contiguous segments keep their zoom so nothing jumps
 * mid-sentence. A crossfade is used sparingly, only between different clips that
 * look like a change of scene (a different recording setup). Otherwise zoom 1, cut.
 */
export function applyZoomAndTransitions(segments: Segment[], clips: readonly ClipInfo[], settings: EditSettings): Segment[] {
  if (!settings.zoomAndTransitions) return segments.map((s) => ({ ...s, zoom: 1, transitionIn: 'cut' }));
  const scale = PACING_PARAMS[settings.pacing].punchInScale;
  const clipById = new Map(clips.map((c) => [c.id, c]));
  const out = segments.map((s) => ({ ...s, zoom: 1, transitionIn: 'cut' as Segment['transitionIn'] }));
  let prevKept: Segment | null = null;
  let lastCrossfadeAt = -Infinity;
  let keptIndex = 0;
  for (let i = 0; i < out.length; i++) {
    const seg = out[i]!;
    if (!seg.keep) continue;
    const prevInArray = out[i - 1];
    if (prevKept && prevKept.clipId === seg.clipId) {
      const jumpCut = prevInArray !== undefined && !prevInArray.keep && prevInArray.clipId === seg.clipId;
      seg.zoom = jumpCut ? (prevKept.zoom > 1 ? 1 : scale) : prevKept.zoom;
    } else if (prevKept) {
      const a = clipById.get(prevKept.clipId);
      const b = clipById.get(seg.clipId);
      const sceneChange = !!a && !!b && a.fps !== b.fps && a.scriptLineIndex === undefined && b.scriptLineIndex === undefined;
      const longEnough = seg.end - seg.start >= CROSSFADE_MIN_SEC && prevKept.end - prevKept.start >= CROSSFADE_MIN_SEC;
      if (sceneChange && longEnough && keptIndex - lastCrossfadeAt > 3) {
        seg.transitionIn = 'crossfade';
        lastCrossfadeAt = keptIndex;
      }
    }
    prevKept = seg;
    keptIndex++;
  }
  return out;
}
