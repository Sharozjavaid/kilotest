import { describe, expect, it } from 'vitest';
import type { ClipInfo, Transcript } from '@kilo/edl';
import { assColor, buildAss, groupCues, mapWords } from '../src/captions.js';
import { buildPlan } from '../src/plan.js';
import { baseEdl, seg } from './helpers.js';

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
      variants: [{ id: 'v', label: 'Hook', hookText: '', segmentOrder: ['b', 'a'], overlays: [] }],
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
    const ass = buildAss(clean, { style: 'clean', width: 1080, height: 1920, accent: '#1F5EFF', lowerGraphics: [], upperGraphics: [] });
    const dialogue = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    expect(dialogue.length).toBe(clean.length);
    for (const l of dialogue) expect(l.split('\\N').length).toBeLessThanOrEqual(2);
    expect(ass).toContain('Style: Clean,Inter SemiBold');
    // Cues never overlap.
    for (let i = 1; i < clean.length; i++) expect(clean[i]!.start).toBeGreaterThanOrEqual(clean[i - 1]!.end - 1e-9);
  });

  it('karaoke highlights each word in the accent colour, one event per word', () => {
    const cues = groupCues(ws, 'karaoke', plan.items);
    const ass = buildAss(cues, { style: 'karaoke', width: 1080, height: 1920, accent: '#1F5EFF', lowerGraphics: [], upperGraphics: [] });
    const dialogue = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    expect(dialogue.length).toBe(ws.length);
    expect(assColor('#1F5EFF')).toBe('&H00FF5E1F');
    for (const l of dialogue) expect(l.split(`\\1c${assColor('#1F5EFF')}`).length).toBe(2);
  });

  it('moves captions up while a lower graphic is on screen', () => {
    const cues = groupCues(ws, 'clean', plan.items);
    const ass = buildAss(cues, {
      style: 'clean',
      width: 1080,
      height: 1920,
      accent: '#1F5EFF',
      lowerGraphics: [[0, 0.5]],
      upperGraphics: [],
    });
    const dialogue = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    expect(dialogue[0]).toContain('\\pos(');
    expect(dialogue[dialogue.length - 1]).not.toContain('\\pos(');
  });

  it('shifts and clips events for a chunk', () => {
    const cues = groupCues(ws, 'clean', plan.items);
    const ass = buildAss(cues, { style: 'clean', width: 540, height: 960, accent: '#1F5EFF', lowerGraphics: [], upperGraphics: [] }, 2, 1);
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
