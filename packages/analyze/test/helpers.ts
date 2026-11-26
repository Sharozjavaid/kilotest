import type { BrollAsset, ClipInfo, DecideInput, EditSettings, SilenceGap, Transcript, Word } from '@kilo/edl';
import { MODE_PRESETS } from '@kilo/edl';

/** Builds a synthetic clip the way fixtures/generate.mjs does, without audio. */
export type UnitSpec = { say: string } | { filler: string } | { pause: number };

export interface SynthClip {
  info: ClipInfo;
  transcript: Transcript;
  silences: SilenceGap[];
  /** Speech units with their bounds, for assertions. */
  units: Array<{ text: string; start: number; end: number; filler: boolean }>;
}

const SPEECH_RATE = 0.075; // seconds per character, about espeak at 160 wpm

export function synthClip(id: string, order: number, units: UnitSpec[], opts: { fps?: number; leadIn?: number; tail?: number; scriptLineIndex?: number; takeNumber?: number } = {}): SynthClip {
  let t = opts.leadIn ?? 0.4;
  const words: Word[] = [];
  const silences: SilenceGap[] = [];
  const out: SynthClip['units'] = [];
  let silenceStart = 0;
  units.forEach((u, i) => {
    if ('pause' in u) {
      t += u.pause;
      return;
    }
    const text = 'say' in u ? u.say : u.filler;
    const dur = Math.max(0.2, text.replace(/\s+/g, '').length * SPEECH_RATE);
    if (t - silenceStart >= 0.1) silences.push({ clipId: id, start: silenceStart, end: t });
    const toks = text.split(/\s+/).filter(Boolean);
    const total = toks.reduce((n, w) => n + w.length, 0);
    let wt = t;
    for (const tok of toks) {
      const wd = (dur * tok.length) / total;
      words.push({ text: tok, start: round(wt), end: round(wt + wd), confidence: 1, filler: 'filler' in u });
      wt += wd;
    }
    out.push({ text, start: round(t), end: round(t + dur), filler: 'filler' in u });
    t += dur;
    silenceStart = t;
    const next = units[i + 1];
    if (next && !('pause' in next)) t += 0.14;
  });
  t += opts.tail ?? 0.5;
  const durationSec = round(t);
  if (durationSec - silenceStart >= 0.1) silences.push({ clipId: id, start: silenceStart, end: durationSec });
  return {
    info: {
      id, order, durationSec, fps: opts.fps ?? 30, width: 1080, height: 1920,
      ...(opts.scriptLineIndex !== undefined ? { scriptLineIndex: opts.scriptLineIndex } : {}),
      ...(opts.takeNumber !== undefined ? { takeNumber: opts.takeNumber } : {}),
    },
    transcript: { clipId: id, language: 'en', durationSec, words },
    silences,
    units: out,
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function decideInput(clips: SynthClip[], settings: Partial<EditSettings> = {}, extra: Partial<DecideInput> = {}): DecideInput {
  return {
    videoId: 'v1',
    clips: clips.map((c) => c.info),
    transcripts: clips.map((c) => c.transcript),
    silences: clips.flatMap((c) => c.silences),
    settings: { ...MODE_PRESETS.general.settings, ...settings },
    broll: [],
    ...extra,
  };
}

export const ASSETS: BrollAsset[] = [
  { id: 'b1', kind: 'video', durationSec: 4, width: 1080, height: 1920, description: 'Bathroom shelf close-up with skincare bottles', source: 'user' },
  { id: 'b2', kind: 'image', width: 1600, height: 1200, description: 'Stopwatch on a kitchen counter', source: 'user' },
  { id: 'b3', kind: 'video', durationSec: 1.8, width: 1080, height: 1920, description: 'Hand holding the product bottle', source: 'user' },
];

/** A talking clip with retakes, fillers, a list, a price and a stat. */
export function richClips(): SynthClip[] {
  return [
    synthClip('c1', 0, [
      { say: 'Okay so I have been' },
      { filler: 'uh' },
      { say: 'hold on' },
      { pause: 1.4 },
      { say: 'Okay, I have used this every morning for two weeks.' },
      { pause: 1.8 },
      { say: "Here's what nobody tells you about it." },
      { pause: 0.9 },
      { say: 'Three mistakes people make.' },
      { say: 'Number one, you use too little.' },
      { filler: 'um' },
      { say: 'Number two, you skip your neck.' },
      { pause: 0.8 },
      { say: 'Number three, you never reapply.' },
      { pause: 1.0 },
    ]),
    synthClip('c2', 1, [
      { say: 'Ninety percent of people skip this step.' },
      { pause: 1.2 },
      { say: 'Ninety percent of people skip this step.' },
      { say: 'It takes ten seconds on your shelf and it actually works.' },
      { pause: 0.8 },
      { say: 'It is twelve dollars today, down from twenty.' },
      { pause: 1.6 },
      { say: 'Check the shop link below.' },
    ], { fps: 60 }),
  ];
}
