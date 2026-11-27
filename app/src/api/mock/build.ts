import type { BrollAssetView, ClipInfo, Edl, EditSettings, Overlay, Segment, Transcript, Variant } from '@kilo/edl';
import { FIXTURE, FIXTURE_UNITS, FIXTURE_WORDS, type FixtureUnit } from './fixture';

/**
 * Builds realistic analysis output (clips, transcripts, EDL) for a mock video from
 * the `routine` fixture. The proxy file is that one recording; a video made of N
 * clips splits it at unit boundaries into N consecutive clips, so the concatenated
 * proxy and `clipOffsets` stay exactly right.
 *
 * The fixture labels its first false start as `false_start`; the mock relabels it
 * `retake` (it is an earlier take of the line kept at 0:04) so every cut reason
 * appears in mock data.
 */

interface PlacedUnit extends FixtureUnit {
  index: number;
}

/** Units with gaps absorbed so they partition 0..duration. */
function partitionedUnits(): PlacedUnit[] {
  return FIXTURE_UNITS.map((u, i) => {
    const start = i === 0 ? 0 : u.start;
    const next = FIXTURE_UNITS[i + 1];
    const end = next ? next.start : FIXTURE.durationSec;
    const reason = i === 0 ? 'retake' : u.reason;
    return { ...u, reason, start, end, index: i };
  });
}

export interface MockAnalysis {
  clips: ClipInfo[];
  transcripts: Transcript[];
  edl: Edl;
  clipOffsets: Record<string, number>;
  totalSec: number;
}

/** Split points: unit index where each clip after the first begins. */
function splitIndices(units: number, clips: number): number[] {
  const n = Math.max(1, Math.min(clips, units));
  const out: number[] = [];
  for (let k = 1; k < n; k++) out.push(Math.round((k * units) / n));
  return out;
}

export function buildMockAnalysis(opts: {
  videoId: string;
  clipIds: string[];
  settings: EditSettings;
  broll?: BrollAssetView[];
  revision?: number;
}): MockAnalysis {
  const units = partitionedUnits();
  const clipIds = opts.clipIds.slice(0, units.length);
  const extraClipIds = opts.clipIds.slice(units.length);
  const splits = splitIndices(units.length, clipIds.length);
  const bounds = [0, ...splits, units.length];

  const clips: ClipInfo[] = [];
  const transcripts: Transcript[] = [];
  const segments: Segment[] = [];
  const clipOffsets: Record<string, number> = {};

  clipIds.forEach((clipId, c) => {
    const from = bounds[c]!;
    const to = bounds[c + 1]!;
    const clipStart = units[from]!.start;
    const clipEnd = units[to - 1]!.end;
    const duration = round(clipEnd - clipStart);
    clipOffsets[clipId] = round(clipStart);
    clips.push({ id: clipId, order: c, durationSec: duration, fps: FIXTURE.fps, width: FIXTURE.width, height: FIXTURE.height });
    transcripts.push({
      clipId,
      language: 'en',
      durationSec: duration,
      words: FIXTURE_WORDS.filter(([, s]) => s >= clipStart && s < clipEnd).map(([text, s, e, filler]) => ({
        text,
        start: round(s - clipStart),
        end: round(Math.min(e, clipEnd) - clipStart),
        confidence: 1,
        filler: filler === 1,
      })),
    });
    let keptIndex = 0;
    for (let i = from; i < to; i++) {
      const u = units[i]!;
      const zoom = opts.settings.zoomAndTransitions && u.keep ? (keptIndex++ % 2 === 1 ? 1.08 : 1) : 1;
      segments.push({
        id: `s${u.index}`,
        clipId,
        start: round(u.start - clipStart),
        end: round(u.end - clipStart),
        keep: u.keep,
        reason: u.reason,
        text: u.text,
        zoom,
        transitionIn: 'cut',
        userOverride: false,
      });
    }
  });
  // Clips beyond what the fixture can split into are kept as short silent clips cut as dead air.
  let offset = FIXTURE.durationSec;
  extraClipIds.forEach((clipId, j) => {
    const duration = 1;
    clipOffsets[clipId] = offset;
    clips.push({ id: clipId, order: clipIds.length + j, durationSec: duration, fps: FIXTURE.fps, width: FIXTURE.width, height: FIXTURE.height });
    transcripts.push({ clipId, language: 'en', durationSec: duration, words: [] });
    segments.push({ id: `x${j}`, clipId, start: 0, end: duration, keep: false, reason: 'dead_air', text: '', zoom: 1, transitionIn: 'cut', userOverride: false });
    offset += duration;
  });

  const overlays: Overlay[] = [];
  const readyBroll = (opts.broll ?? []).filter((b) => b.status === 'ready');
  if (opts.settings.broll && readyBroll[0]) {
    const b = readyBroll[0];
    overlays.push({
      id: 'o-broll-1',
      type: 'broll',
      // On the last line, clear of the graphics: overlays never overlap.
      anchorSegmentId: 's13',
      offsetSec: 0.3,
      durationSec: 1.6,
      assetId: b.id,
      sourceStartSec: 0,
      ...(b.kind === 'image' ? { kenBurns: { fromScale: 1, toScale: 1.12, fromX: 0, fromY: 0, toX: 0.1, toY: -0.05 } } : {}),
    });
  }
  if (opts.settings.graphics) {
    overlays.push({
      id: 'o-graphic-1',
      type: 'graphic',
      anchorSegmentId: 's6',
      offsetSec: 0,
      durationSec: 1.6,
      template: 'bold-title',
      props: { text: 'Nobody tells you this' },
    });
    overlays.push({
      id: 'o-graphic-2',
      type: 'graphic',
      anchorSegmentId: 's11',
      offsetSec: 0.2,
      durationSec: 2,
      template: 'stat-callout',
      props: { value: '10 sec', label: 'is all it takes' },
    });
  }

  const variants: Variant[] = [];
  if (opts.settings.hookVariations > 1) {
    const orders: Array<{ label: string; order: string[] }> = [
      { label: 'Hook A', order: ['s4', 's6', 's11', 's13'] },
      { label: 'Hook B', order: ['s6', 's4', 's11', 's13'] },
      { label: 'Hook C', order: ['s11', 's4', 's6', 's13'] },
    ];
    const textOf = new Map(segments.map((s) => [s.id, s.text]));
    orders.slice(0, Math.min(3, opts.settings.hookVariations)).forEach((o, i) => {
      variants.push({
        id: `hook-${String.fromCharCode(97 + i)}`,
        label: o.label,
        hookText: textOf.get(o.order[0]!) ?? '',
        segmentOrder: o.order,
        overlays:
          i === 0 && opts.settings.graphics
            ? [{ id: 'o-hook-a', type: 'graphic', anchorSegmentId: 's4', offsetSec: 0, durationSec: 1.4, template: 'keyword-pop', props: { words: ['two', 'weeks'] } }]
            : [],
        // Hook B opens on s6: its title graphic would cover the opening line, so this version leaves it out.
        hiddenOverlayIds: o.order[0] === 's6' && opts.settings.graphics ? ['o-graphic-1'] : [],
      });
    });
  }

  const edl: Edl = {
    version: 1,
    videoId: opts.videoId,
    revision: opts.revision ?? 0,
    fps: FIXTURE.fps,
    width: 1080,
    height: 1920,
    settings: opts.settings,
    segments,
    overlays,
    captions: { enabled: opts.settings.captions, style: opts.settings.captionStyle },
    variants,
    decidedBy: 'heuristic',
  };
  return { clips, transcripts, edl, clipOffsets, totalSec: round(offset) };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
