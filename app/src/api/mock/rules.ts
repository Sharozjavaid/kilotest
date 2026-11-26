import type { Edl } from '@kilo/edl';

/**
 * The server's rules (server/src/api/videos.ts, batches.ts), mirrored for the mock so
 * the app meets the same refusals offline. src/api/conformance runs the same
 * scenarios against both to keep them in step.
 */

/** Most a saved EDL may hold (server EDL_LIMITS). */
export const EDL_LIMITS = { segments: 4000, overlays: 40, variantOverlays: 10, variants: 5 } as const;

export const CLIP_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm', 'mkv', '3gp'] as const;
export const BROLL_EXTENSIONS = [...CLIP_EXTENSIONS, 'jpg', 'jpeg', 'png', 'webp', 'heic'] as const;

const EXT_BY_TYPE: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-m4v': 'm4v',
  'video/x-matroska': 'mkv',
  'video/3gpp': '3gp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

/** The storage extension for a clip or B-roll file, or null when Kilo does not take that type. */
export function mediaExtension(filename: string, contentType: string, kind: 'clip' | 'broll'): string | null {
  const allowed: readonly string[] = kind === 'clip' ? CLIP_EXTENSIONS : BROLL_EXTENSIONS;
  const fromName = /\.([A-Za-z0-9]{1,5})$/.exec(filename)?.[1]?.toLowerCase();
  const ext = fromName ?? EXT_BY_TYPE[contentType.toLowerCase().split(';')[0]!.trim()];
  if (!ext || !allowed.includes(ext)) return null;
  return ext === 'jpeg' ? 'jpg' : ext;
}

/**
 * The EDL a save stores: cut points, segment reasons and text, variant labels, fps,
 * settings and decider stay as stored; a client changes only keep, userOverride,
 * zoom, transitionIn, overlays, captions and each variant's order and overlays.
 */
export function mergeClientEdl(stored: Edl, client: Edl): { edl: Edl; problems: string[] } {
  const problems: string[] = [];
  if (client.segments.length > EDL_LIMITS.segments) problems.push(`An edit has at most ${EDL_LIMITS.segments} segments`);
  if (client.overlays.length > EDL_LIMITS.overlays) problems.push(`An edit has at most ${EDL_LIMITS.overlays} overlays`);
  if (client.variants.length > EDL_LIMITS.variants) problems.push(`An edit has at most ${EDL_LIMITS.variants} variants`);
  for (const v of client.variants) {
    if (v.overlays.length > EDL_LIMITS.variantOverlays) problems.push(`Variant ${v.id} has more than ${EDL_LIMITS.variantOverlays} overlays`);
  }
  if (problems.length) return { edl: stored, problems };
  const sameCut =
    client.segments.length === stored.segments.length &&
    client.segments.every((s, i) => {
      const t = stored.segments[i]!;
      return s.id === t.id && s.clipId === t.clipId && Math.abs(s.start - t.start) < 1e-6 && Math.abs(s.end - t.end) < 1e-6;
    });
  if (!sameCut) problems.push('Segments cannot be added, removed, reordered or re-timed; a save may only keep or cut them');
  const storedVariants = new Map(stored.variants.map((v) => [v.id, v]));
  const ids = client.variants.map((v) => v.id);
  if (new Set(ids).size !== ids.length) problems.push('Duplicate variant id');
  if (ids.length !== storedVariants.size || ids.some((id) => !storedVariants.has(id))) {
    problems.push('Variants cannot be added or removed in a save; replan to make new ones');
  }
  if (problems.length) return { edl: stored, problems };
  return {
    problems,
    edl: {
      ...stored,
      segments: stored.segments.map((t, i) => {
        const s = client.segments[i]!;
        return { ...t, keep: s.keep, userOverride: s.userOverride, zoom: s.zoom, transitionIn: s.transitionIn };
      }),
      overlays: client.overlays,
      captions: client.captions,
      variants: client.variants.map((v) => ({ ...storedVariants.get(v.id)!, segmentOrder: v.segmentOrder, overlays: v.overlays })),
    },
  };
}
