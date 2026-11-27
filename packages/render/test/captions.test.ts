import { describe, expect, it } from 'vitest';
import { CAPTION_HIGHLIGHT, type ClipInfo, type Transcript } from '@kilo/edl';
import { assColor, buildAss, groupCues, mapWords, subtractRanges } from '../src/captions.js';
import { buildPlan } from '../src/plan.js';
import { baseEdl, seg } from './helpers.js';

/** h:mm:ss.cc to seconds. */
const parseAss = (t: string) => {
  const [h, m, sec] = t.split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(sec);
};

const clip = (id: string, durationSec: number): { path: string; info: ClipInfo } => ({
  path: `/x/${id}.mp4`,
  info: { id, order: 0, durationSec, fps: 30, width: 1080, height: 1920 },
});

const words = (clipId: string, list: Array<[string, number, number]>): Transcript => ({
  clipId,
  language: 'en',
  durationSec: 10,
  words: list.map(([text, start, end]) => ({ text, start, end, filler: false })),
});

const transcript = words('c1', [
  ['one', 0.1, 0.4],
  ['two', 0.5, 0.8],
  ['cutword', 1.2, 1.6],
  ['three', 2.1, 2.4],
  ['four', 2.5, 2.9],
]);

describe('mapWords', () => {
  const segments = [seg('a', 'c1', 0, 1), seg('x', 'c1', 1, 2, false), seg('b', 'c1', 2, 3)];

  it('drops words in cut segments and shifts the rest onto the output timeline', () => {
    const edl = baseEdl(segments, 30);
    const plan = buildPlan({ edl, quality: 'final', clips: { c1: clip('c1', 3) }, broll: {} });
    const out = mapWords(plan.items, [transcript], 30);
    expect(out.map((w) => w.text)).toEqual(['one', 'two', 'three', 'four']);
    expect(out[2]!.start).toBeCloseTo(1.1, 3); // 2.1 in the source, after 1 s of cut
  });

  it('follows a reordered variant', () => {
    const edl = baseEdl(segments, 30, {
      variants: [{ id: 'v', label: 'Hook', hookText: '', segmentOrder: ['b', 'a'], overlays: [], hiddenOverlayIds: [] }],
    });
    const plan = buildPlan({ edl, variantId: 'v', quality: 'final', clips: { c1: clip('c1', 3) }, broll: {} });
    const out = mapWords(plan.items, [transcript], 30);
    expect(out.map((w) => w.text)).toEqual(['three', 'four', 'one', 'two']);
    expect(out[0]!.start).toBeCloseTo(0.1, 3);
    expect(out[2]!.start).toBeCloseTo(1.1, 3);
  });
});

describe('groupCues and buildAss', () => {
  const long = words(
    'c1',
    'so here is the thing nobody tells you about mornings and coffee'.split(' ').map((w, i) => [w, i * 0.3, i * 0.3 + 0.25]),
  );
  const edl = baseEdl([seg('a', 'c1', 0, 5)], 30);
  const plan = buildPlan({ edl, quality: 'final', clips: { c1: clip('c1', 5) }, broll: {} });
  const ws = mapWords(plan.items, [long], 30);

  it('bold shows 2 to 4 words at a time, clean at most two short lines', () => {
    const bold = groupCues(ws, 'bold', plan.items);
    for (const c of bold) {
      expect(c.words.length).toBeGreaterThanOrEqual(2);
      expect(c.words.length).toBeLessThanOrEqual(4);
    }
    const clean = groupCues(ws, 'clean', plan.items);
    const ass = buildAss(clean, { style: 'clean', width: 1080, height: 1920, highlight: CAPTION_HIGHLIGHT, lowerGraphics: [], upperGraphics: [] });
    const dialogue = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    expect(dialogue.length).toBe(clean.length);
    for (const l of dialogue) expect(l.split('\\N').length).toBeLessThanOrEqual(2);
    expect(ass).toContain('Style: Clean,Inter SemiBold');
    // Cues never overlap.
    for (let i = 1; i < clean.length; i++) expect(clean[i]!.start).toBeGreaterThanOrEqual(clean[i - 1]!.end - 1e-9);
  });

  it('karaoke highlights each word in CAPTION_HIGHLIGHT, one event per word', () => {
    const cues = groupCues(ws, 'karaoke', plan.items);
    const ass = buildAss(cues, { style: 'karaoke', width: 1080, height: 1920, highlight: CAPTION_HIGHLIGHT, lowerGraphics: [], upperGraphics: [] });
    const dialogue = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    expect(dialogue.length).toBe(ws.length);
    expect(assColor('#1F5EFF')).toBe('&H00FF5E1F');
    expect(assColor(CAPTION_HIGHLIGHT)).toBe('&H004AE9FF');
    for (const l of dialogue) expect(l.split(`\\1c${assColor(CAPTION_HIGHLIGHT)}`).length).toBe(2);
  });

  it('moves captions up while a lower graphic is on screen', () => {
    const cues = groupCues(ws, 'clean', plan.items);
    const ass = buildAss(cues, {
      style: 'clean',
      width: 1080,
      height: 1920,
      highlight: CAPTION_HIGHLIGHT,
      lowerGraphics: [[0, 0.5]],
      upperGraphics: [],
    });
    const dialogue = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    expect(dialogue[0]).toContain('\\pos(');
    expect(dialogue[dialogue.length - 1]).not.toContain('\\pos(');
  });

  it('shows no caption while a full-screen graphic is on screen, and brings it back after', () => {
    const cues = groupCues(ws, 'clean', plan.items);
    const last = cues[cues.length - 1]!;
    const hole: [number, number] = [cues[0]!.start + 0.3, (last.start + last.words[0]!.end) / 2];
    expect(cues.length).toBeGreaterThan(1);
    for (const style of ['clean', 'karaoke'] as const) {
      const ass = buildAss(groupCues(ws, style, plan.items), {
        style, width: 1080, height: 1920, highlight: CAPTION_HIGHLIGHT, lowerGraphics: [], upperGraphics: [], fullscreenGraphics: [hole],
      });
      const events = ass
        .split('\n')
        .filter((l) => l.startsWith('Dialogue:'))
        .map((l) => l.split(',').slice(1, 3).map(parseAss) as [number, number]);
      for (const [a, b] of events) expect(b <= hole[0] || a >= hole[1], `${a}-${b} inside ${hole}`).toBe(true);
      // The first cue is cut at the graphic's start and the captions resume at its end.
      expect(events.some(([, b]) => Math.abs(b - hole[0]) < 0.03)).toBe(true);
      expect(events.some(([a]) => Math.abs(a - hole[1]) < 0.03)).toBe(true);
    }
  });

  it('subtractRanges', () => {
    expect(subtractRanges(0, 10, [[2, 3], [5, 6]])).toEqual([[0, 2], [3, 5], [6, 10]]);
    expect(subtractRanges(0, 10, [[-1, 11]])).toEqual([]);
    expect(subtractRanges(4, 5, [[0, 1]])).toEqual([[4, 5]]);
  });

  it('shifts and clips events for a chunk', () => {
    const cues = groupCues(ws, 'clean', plan.items);
    const ass = buildAss(cues, { style: 'clean', width: 540, height: 960, highlight: CAPTION_HIGHLIGHT, lowerGraphics: [], upperGraphics: [] }, 2, 1);
    const times = ass
      .split('\n')
      .filter((l) => l.startsWith('Dialogue:'))
      .map((l) => l.split(',').slice(1, 3));
    expect(times.length).toBeGreaterThan(0);
    for (const [a, b] of times) {
      expect(a! >= '0:00:00.00').toBe(true);
      expect(b! <= '0:00:01.00').toBe(true);
    }
  });
});
