import {
  TEMPLATES,
  TemplatePropsSchemas,
  getTemplate,
  resolveTimeline,
  type BrollAssetView,
  type Edl,
  type KenBurns,
  type Overlay,
  type Segment,
  type TemplateId,
} from '@kilo/edl';

/**
 * Editing the overlays of an EDL from the B-roll screen. Pure, so it is unit-tested.
 *
 * Rules every edit keeps (checked on the base cut, the timeline the B-roll screen shows).
 * The first two are the server's (CONTRACTS.md section 5; a save that breaks them
 * answers 400), and `checkOverlays` reports exactly what the server would refuse:
 * - no overlay overlaps another on the base cut, counting each variant's own overlays
 *   (a hook title) together with the base overlays;
 * - no B-roll starts in the first two seconds of the base cut (the hook stays on the
 *   speaker); a variant's overlays are exempt.
 * The editor is stricter when it places something: it starts graphics after the first
 * two seconds too, and keeps a duration within the asset's length (video B-roll) or
 * the template's min/max.
 *
 * Overlays stay anchored to a segment (`anchorSegmentId` + `offsetSec`); positions on
 * the output timeline come from `resolveTimeline`.
 */

/** Nothing may start before this point of the finished video. */
export const SAFE_START_SEC = 2;

/** Durations for photos (they get a slow pan) and short video clips. */
export const IMAGE_DURATION = { min: 1, max: 6, default: 2.4 } as const;
export const VIDEO_MIN_SEC = 0.8;
export const VIDEO_DEFAULT_SEC = 2.4;

/** Slow pan used for stills placed from the app. */
export const DEFAULT_KEN_BURNS: KenBurns = { fromScale: 1, toScale: 1.12, fromX: 0, fromY: 0, toX: 0.08, toY: -0.04 };

const EPS = 1e-3;

/** The asset fields overlay editing needs. */
export type OverlayAsset = Pick<BrollAssetView, 'id' | 'kind' | 'durationSec' | 'status' | 'description' | 'filename' | 'source'> &
  Partial<Pick<BrollAssetView, 'attribution' | 'thumbnailUrl'>>;

/** What fills an overlay slot: a B-roll asset or a motion graphic. */
export type OverlayContent =
  | { type: 'broll'; asset: OverlayAsset }
  | { type: 'graphic'; template: TemplateId; props: Record<string, unknown> };

export interface SpokenLine {
  segment: Segment;
  outStart: number;
  outEnd: number;
  /** Base overlays anchored to this segment, by start time. */
  overlays: Overlay[];
}

/** Kept spoken lines of the base cut in play order, with the overlays anchored to each. */
export function spokenLines(edl: Edl): SpokenLine[] {
  const tl = resolveTimeline(edl);
  const byAnchor = new Map<string, Overlay[]>();
  for (const o of [...edl.overlays].sort((a, b) => a.offsetSec - b.offsetSec)) {
    const list = byAnchor.get(o.anchorSegmentId) ?? [];
    list.push(o);
    byAnchor.set(o.anchorSegmentId, list);
  }
  return tl.items
    .filter((i) => i.segment.reason === 'speech' && i.segment.text.trim().length > 0)
    .map((i) => ({ segment: i.segment, outStart: i.outStart, outEnd: i.outEnd, overlays: byAnchor.get(i.segment.id) ?? [] }));
}

/** Overlays that play in the base cut (their anchor is kept). */
export function placedCount(edl: Edl): number {
  return resolveTimeline(edl).overlays.filter((o) => edl.overlays.includes(o.overlay)).length;
}

export interface DurationLimits {
  min: number;
  max: number;
  default: number;
}

/** How long this content may run. Video B-roll is limited by the clip's length. */
export function durationLimits(content: OverlayContent, sourceStartSec = 0): DurationLimits {
  if (content.type === 'graphic') {
    const t = getTemplate(content.template);
    return { min: t.minDurationSec, max: t.maxDurationSec, default: t.defaultDurationSec };
  }
  if (content.asset.kind === 'image') return { ...IMAGE_DURATION };
  const len = Math.max(0, (content.asset.durationSec ?? 0) - sourceStartSec);
  const max = round1(len);
  return { min: Math.min(VIDEO_MIN_SEC, max), max, default: Math.min(VIDEO_DEFAULT_SEC, max) };
}

export type OverlayProblemCode =
  | 'first_seconds'
  | 'overlap'
  | 'too_short'
  | 'too_long'
  | 'no_room'
  | 'not_playing'
  | 'unknown_anchor'
  | 'asset_not_ready'
  | 'invalid_props';

export interface OverlayProblem {
  code: OverlayProblemCode;
  message: string;
  overlayId?: string;
}

/** The content an existing overlay holds, given the video's assets. Null when its asset is gone. */
export function contentOf(overlay: Overlay, assets: readonly OverlayAsset[]): OverlayContent | null {
  if (overlay.type === 'graphic') return { type: 'graphic', template: overlay.template, props: overlay.props };
  const asset = assets.find((a) => a.id === overlay.assetId);
  return asset ? { type: 'broll', asset } : null;
}

/** Every rule broken by the base overlays of `edl`. Empty means the overlays are sound. */
export function checkOverlays(edl: Edl, assets?: readonly OverlayAsset[]): OverlayProblem[] {
  const problems: OverlayProblem[] = [];
  const ids = new Set(edl.segments.map((s) => s.id));
  const tl = resolveTimeline(edl);
  const placed = tl.overlays.filter((o) => edl.overlays.includes(o.overlay));
  for (const o of edl.overlays) {
    if (!ids.has(o.anchorSegmentId)) problems.push({ code: 'unknown_anchor', overlayId: o.id, message: 'This overlay is anchored to a line that no longer exists.' });
    if (o.type === 'graphic' && !TemplatePropsSchemas[o.template].safeParse(o.props).success) {
      problems.push({ code: 'invalid_props', overlayId: o.id, message: `The ${getTemplate(o.template).name} text does not fit the template.` });
    }
    if (assets) {
      const content = contentOf(o, assets);
      if (content) {
        const lim = durationLimits(content, o.type === 'broll' ? o.sourceStartSec : 0);
        if (o.durationSec < lim.min - EPS) problems.push({ code: 'too_short', overlayId: o.id, message: `At least ${fmtSec(lim.min)}.` });
        if (o.durationSec > lim.max + EPS) problems.push({ code: 'too_long', overlayId: o.id, message: `At most ${fmtSec(lim.max)}.` });
      }
    }
  }
  for (const p of placed) {
    if (p.overlay.type === 'broll' && p.outStart < SAFE_START_SEC - EPS) {
      problems.push({ code: 'first_seconds', overlayId: p.overlay.id, message: 'The first two seconds stay on you.' });
    }
  }
  const reported = new Set<string>();
  for (const set of overlaySets(edl)) {
    const sorted = onBaseCut(edl, set).sort((a, b) => a.outStart - b.outStart || a.outEnd - b.outEnd);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length && sorted[j]!.outStart < sorted[i]!.outEnd - EPS; j++) {
        const id = sorted[j]!.overlay.id;
        if (reported.has(id)) continue;
        reported.add(id);
        problems.push({ code: 'overlap', overlayId: id, message: 'Two overlays would play at the same time.' });
      }
    }
  }
  return problems;
}

/** The base overlays, then the base overlays with each variant's own: the sets that play together. */
function overlaySets(edl: Edl): Overlay[][] {
  return [edl.overlays, ...edl.variants.filter((v) => v.overlays.length).map((v) => [...edl.overlays, ...v.overlays])];
}

/** Where overlays play on the base cut (overlays on a cut line are left out). */
function onBaseCut(edl: Edl, overlays: readonly Overlay[]) {
  return resolveTimeline({ ...edl, overlays: [...overlays], variants: [] }).overlays;
}

export interface PlaceOptions {
  /** Keep this id (swapping); a new one is made otherwise. */
  id?: string;
  /** Wanted duration; the content's default when omitted. Clamped to the limits and the room available. */
  durationSec?: number;
  /** Wanted offset into the anchor; pushed later when it would break a rule. */
  offsetSec?: number;
  sourceStartSec?: number;
  makeId?: () => string;
}

export type PlaceResult = { ok: true; overlay: Overlay; edl: Edl } | { ok: false; problem: OverlayProblem };

let idSeq = 0;
export function newOverlayId(): string {
  idSeq += 1;
  return `o-app-${Date.now().toString(36)}-${idSeq}`;
}

/**
 * Puts `content` on the line `anchorSegmentId`, replacing the overlay with `opts.id`
 * if there is one. Finds the earliest start in the line that is past the first two
 * seconds and clear of other overlays, then fits the duration into the room before
 * the next overlay (and the end of the video). Fails with a problem the screen can
 * show when there is no room for even the minimum duration.
 */
export function placeOverlay(edl: Edl, anchorSegmentId: string, content: OverlayContent, opts: PlaceOptions = {}): PlaceResult {
  if (content.type === 'broll' && content.asset.status !== 'ready') {
    return { ok: false, problem: { code: 'asset_not_ready', message: 'This clip is still processing. Try again in a moment.' } };
  }
  if (content.type === 'graphic') {
    const parsed = TemplatePropsSchemas[content.template].safeParse(content.props);
    if (!parsed.success) return { ok: false, problem: { code: 'invalid_props', message: `The ${getTemplate(content.template).name} text does not fit the template.` } };
  }
  const others = edl.overlays.filter((o) => o.id !== opts.id);
  const base: Edl = { ...edl, overlays: others };
  const tl = resolveTimeline(base);
  const anchor = tl.items.find((i) => i.segment.id === anchorSegmentId);
  if (!edl.segments.some((s) => s.id === anchorSegmentId)) {
    return { ok: false, problem: { code: 'unknown_anchor', message: 'That line is no longer in the video.' } };
  }
  if (!anchor) return { ok: false, problem: { code: 'not_playing', message: 'That line is cut. Put it back in Review first.' } };

  const sourceStartSec = opts.sourceStartSec ?? 0;
  const lim = durationLimits(content, sourceStartSec);
  if (lim.max < lim.min - EPS || lim.max <= 0) {
    return { ok: false, problem: { code: 'too_short', message: 'This clip is too short to use.' } };
  }
  // Clear of the other base overlays and of every variant's own overlays (a hook title), which play over the base cut too.
  const variantOverlays = edl.variants.flatMap((v) => v.overlays);
  const busy = onBaseCut(edl, [...others, ...variantOverlays]).map((o) => [o.outStart, o.outEnd] as const);
  const segLen = anchor.outEnd - anchor.outStart;
  // Earliest start inside the line: past the safe zone and the wanted offset, then past any overlay covering it.
  let start = Math.max(anchor.outStart + (opts.offsetSec ?? 0), SAFE_START_SEC);
  for (let moved = true; moved; ) {
    moved = false;
    for (const [s, e] of busy) {
      if (s <= start + EPS && e > start + EPS) {
        start = e;
        moved = true;
      }
    }
  }
  if (start - anchor.outStart >= segLen - EPS) {
    const code: OverlayProblemCode = anchor.outEnd <= SAFE_START_SEC + EPS ? 'first_seconds' : 'no_room';
    return {
      ok: false,
      problem: { code, message: code === 'first_seconds' ? 'The first two seconds stay on you. Pick a later line.' : 'Another overlay already fills this line.' },
    };
  }
  const nextStart = Math.min(tl.durationSec, ...busy.filter(([s]) => s > start + EPS).map(([s]) => s));
  const room = nextStart - start;
  if (room < lim.min - EPS) {
    return { ok: false, problem: { code: 'no_room', message: `Not enough room here: this needs ${fmtSec(lim.min)} and the gap is ${fmtSec(room)}.` } };
  }
  const durationSec = floor2(clamp(opts.durationSec ?? lim.default, lim.min, Math.min(lim.max, room)));
  const offsetSec = round3(start - anchor.outStart);
  const id = opts.id ?? (opts.makeId ?? newOverlayId)();
  const overlay: Overlay =
    content.type === 'graphic'
      ? { id, type: 'graphic', anchorSegmentId, offsetSec, durationSec, template: content.template, props: content.props }
      : {
          id,
          type: 'broll',
          anchorSegmentId,
          offsetSec,
          durationSec,
          assetId: content.asset.id,
          sourceStartSec,
          ...(content.asset.kind === 'image' ? { kenBurns: DEFAULT_KEN_BURNS } : {}),
        };
  const index = edl.overlays.findIndex((o) => o.id === opts.id);
  const overlays = index >= 0 ? edl.overlays.map((o, i) => (i === index ? overlay : o)) : [...edl.overlays, overlay];
  return { ok: true, overlay, edl: { ...edl, overlays } };
}

/** Swaps what an overlay shows, keeping its line and (when it fits) its start. */
export function swapOverlay(edl: Edl, overlayId: string, content: OverlayContent, durationSec?: number): PlaceResult {
  const current = edl.overlays.find((o) => o.id === overlayId);
  if (!current) return { ok: false, problem: { code: 'unknown_anchor', message: 'That overlay was removed.' } };
  return placeOverlay(edl, current.anchorSegmentId, content, { id: overlayId, offsetSec: current.offsetSec, durationSec });
}

/** Changes an overlay's duration within its limits and the room before the next overlay. */
export function setOverlayDuration(edl: Edl, overlayId: string, durationSec: number, assets: readonly OverlayAsset[]): PlaceResult {
  const current = edl.overlays.find((o) => o.id === overlayId);
  if (!current) return { ok: false, problem: { code: 'unknown_anchor', message: 'That overlay was removed.' } };
  const content = contentOf(current, assets);
  if (!content) return { ok: false, problem: { code: 'asset_not_ready', message: 'The clip this overlay uses was removed.' } };
  return placeOverlay(edl, current.anchorSegmentId, content, {
    id: overlayId,
    offsetSec: current.offsetSec,
    durationSec,
    sourceStartSec: current.type === 'broll' ? current.sourceStartSec : 0,
  });
}

/** The longest this overlay could run where it is now. */
export function maxDurationHere(edl: Edl, overlayId: string, assets: readonly OverlayAsset[]): number | null {
  const r = setOverlayDuration(edl, overlayId, Number.MAX_SAFE_INTEGER, assets);
  return r.ok ? r.overlay.durationSec : null;
}

export function removeOverlay(edl: Edl, overlayId: string): Edl {
  return { ...edl, overlays: edl.overlays.filter((o) => o.id !== overlayId) };
}

// ---- Labels for the cards ----------------------------------------------------

export interface OverlayCardText {
  /** YOUR CLIP, MOTION GRAPHIC, STOCK PHOTO, STOCK CLIP. */
  kind: string;
  title: string;
  detail: string;
}

export function overlayCardText(overlay: Overlay, assets: readonly OverlayAsset[]): OverlayCardText {
  const secs = fmtSec(overlay.durationSec);
  if (overlay.type === 'graphic') {
    const index = TEMPLATES.findIndex((t) => t.id === overlay.template);
    const t = getTemplate(overlay.template);
    return { kind: 'MOTION GRAPHIC', title: t.name, detail: `Template ${index + 1} of ${TEMPLATES.length} · ${secs}` };
  }
  const asset = assets.find((a) => a.id === overlay.assetId);
  if (!asset) return { kind: 'YOUR CLIP', title: 'Removed clip', detail: secs };
  const title = assetTitle(asset);
  if (asset.source === 'stock') {
    const credit = asset.attribution ? asset.attribution : 'free to use commercially';
    return {
      kind: asset.kind === 'image' ? 'STOCK PHOTO' : 'STOCK CLIP',
      title,
      detail: asset.kind === 'image' ? `Slow pan · ${credit}` : `${secs} · ${credit}`,
    };
  }
  return { kind: 'YOUR CLIP', title, detail: asset.kind === 'image' ? `Slow pan · ${secs}` : secs };
}

/** The asset's description, or its file name until it has one. */
export function assetTitle(asset: Pick<OverlayAsset, 'description' | 'filename'>): string {
  const d = asset.description.trim();
  if (d) return d;
  return asset.filename.replace(/\.[^.]+$/, '') || 'Your clip';
}

/** "2.4 seconds", "1 second". */
export function fmtSec(sec: number): string {
  const v = round1(sec);
  return `${v} ${v === 1 ? 'second' : 'seconds'}`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
/** Down, so a fitted duration never runs into the next overlay. */
function floor2(n: number): number {
  return Math.floor(n * 100 + 1e-6) / 100;
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ---- Keeping the rules after a cut ------------------------------------------------

/** The shortest an overlay may run: the template's minimum, or the B-roll minimum (photos carry a pan). */
function minDurationOf(o: Overlay): number {
  if (o.type === 'graphic') return getTemplate(o.template).minDurationSec;
  return o.kenBurns ? IMAGE_DURATION.min : VIDEO_MIN_SEC;
}

/** Replaces (or with null removes) the overlay `id`, wherever it lives: the base list or a variant's. */
function mapOverlay(edl: Edl, id: string, next: Overlay | null): Edl {
  const fix = (list: Overlay[]) => (list.some((o) => o.id === id) ? list.flatMap((o) => (o.id === id ? (next ? [next] : []) : [o])) : list);
  return { ...edl, overlays: fix(edl.overlays), variants: edl.variants.map((v) => ({ ...v, overlays: fix(v.overlays) })) };
}

/**
 * Brings the overlays back within the server's rules after the cut changed under
 * them (cutting a line pulls every later overlay earlier, restoring one pushes them
 * later). B-roll that slid into the first two seconds moves to start at the two-second
 * mark if its line is still playing there, else it is dropped. Where two overlays now
 * overlap, the earlier one is shortened to end where the later one starts if it can
 * keep its minimum length, else the later one is dropped. Returns the EDL unchanged
 * (the same object) when nothing breaks a rule.
 */
export function fitOverlays(edl: Edl): Edl {
  if (!checkOverlays(edl).some((p) => p.code === 'first_seconds' || p.code === 'overlap')) return edl;
  let out = edl;
  // B-roll in the first seconds.
  const tl = resolveTimeline({ ...out, variants: [] });
  for (const p of tl.overlays) {
    if (p.overlay.type !== 'broll' || p.outStart >= SAFE_START_SEC - EPS) continue;
    const anchor = tl.items.find((i) => i.segment.id === p.overlay.anchorSegmentId)!;
    const fits = anchor.outEnd - SAFE_START_SEC > EPS && tl.durationSec - SAFE_START_SEC >= minDurationOf(p.overlay) - EPS;
    out = mapOverlay(out, p.overlay.id, fits ? { ...p.overlay, offsetSec: round3(SAFE_START_SEC - anchor.outStart) } : null);
  }
  // Overlaps, one pair at a time until none is left.
  for (let guard = 0; guard < 200; guard++) {
    let pair: [ReturnType<typeof onBaseCut>[number], ReturnType<typeof onBaseCut>[number]] | null = null;
    for (const set of overlaySets(out)) {
      const sorted = onBaseCut(out, set).sort((a, b) => a.outStart - b.outStart || a.outEnd - b.outEnd);
      for (let i = 1; i < sorted.length && !pair; i++) {
        for (let k = 0; k < i; k++) {
          if (sorted[i]!.outStart < sorted[k]!.outEnd - EPS) {
            pair = [sorted[k]!, sorted[i]!];
            break;
          }
        }
      }
      if (pair) break;
    }
    if (!pair) break;
    const [a, b] = pair;
    const room = floor2(b.outStart - a.outStart);
    out = room >= minDurationOf(a.overlay) - EPS ? mapOverlay(out, a.overlay.id, { ...a.overlay, durationSec: room }) : mapOverlay(out, b.overlay.id, null);
  }
  return out;
}
