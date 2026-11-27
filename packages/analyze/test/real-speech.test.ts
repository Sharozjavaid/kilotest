import type { ClipInfo, Transcript, Word } from '@kilo/edl';
import { MODE_PRESETS } from '@kilo/edl';
import { describe, expect, it } from 'vitest';
import { buildChunks, prepareClipWords, trailsOff } from '../src/chunks.js';
import { heuristicCuts } from '../src/heuristic.js';
import { endsSentence, key } from '../src/text.js';

/**
 * What the real-speech recordings (fixtures/real) showed about transcripts that come from
 * speech-to-text rather than from a fixture: punctuation on abandoned starts, abbreviations,
 * questions, lines read with long pauses, and restarts heard differently.
 */

type W = [text: string, start: number, end: number];

function clip(id: string, order: number, words: W[]): { info: ClipInfo; transcript: Transcript } {
  const durationSec = Math.ceil((words[words.length - 1]?.[2] ?? 0) + 1);
  return {
    info: { id, order, durationSec, fps: 30, width: 1080, height: 1920 },
    transcript: { clipId: id, language: 'en', durationSec, words: words.map(([text, start, end]): Word => ({ text, start, end, filler: false })) },
  };
}

/** Utterances with the heuristic's keep for each. */
function decide(clips: Array<{ info: ClipInfo; transcript: Transcript }>, script?: string[]): Array<[string, boolean | undefined]> {
  const cw = prepareClipWords(clips.map((c) => c.info), clips.map((c) => c.transcript));
  const chunks = buildChunks(cw);
  const d = heuristicCuts({ chunks, clipWords: cw, settings: MODE_PRESETS.general.settings, ...(script ? { script } : {}) });
  return chunks.map((c) => [c.text, d.get(c.id)?.keep]);
}

/** Spreads a sentence's words over [start, end], one after another. */
function say(text: string, start: number, end: number): W[] {
  const toks = text.split(' ');
  const step = (end - start) / toks.length;
  return toks.map((t, i) => [t, +(start + i * step).toFixed(3), +(start + (i + 1) * step - 0.02).toFixed(3)]);
}

describe('transcripts from speech-to-text', () => {
  it('reads a trailing-off or broken-off word as unfinished', () => {
    expect(trailsOff('upon...')).toBe(true);
    expect(trailsOff('upon…')).toBe(true);
    expect(trailsOff('bam-')).toBe(true);
    expect(trailsOff('upon.')).toBe(false);
    expect(decide([clip('c', 0, [...say('Have pity upon...', 1, 2.2), ...say('Have pity upon a poor unfortunate one.', 2.25, 5)])])).toEqual([
      ['Have pity upon...', false],
      ['Have pity upon a poor unfortunate one.', true],
    ]);
  });

  it('does not end a sentence on a title, and compares a title with its spelled-out form', () => {
    expect(endsSentence('Mr.')).toBe(false);
    expect(endsSentence('Mrs.')).toBe(false);
    expect(endsSentence('North.')).toBe(true);
    expect(key('Mr.')).toBe(key('mister'));
    expect(key('Dr.')).toBe(key('doctor'));
    // "Wants to come out, Mr. North." is one utterance, kept whole against the script.
    expect(decide([clip('c', 0, say('Wants to come out, Mr. North.', 1, 3))], ['Wants to come out mister north.'])).toEqual([
      ['Wants to come out, Mr. North.', true],
    ]);
  });

  it('cuts an abandoned start that speech-to-text closed with a full stop', () => {
    expect(decide([clip('c', 0, [
      ...say('Jam exclaimed chunky, stretching his neck.', 1, 3.4), ...say('Jam exclaimed chunky, stretching his neck and eyeing the dish longingly.', 5, 9),
    ])])).toEqual([
      ['Jam exclaimed chunky, stretching his neck.', false],
      ['Jam exclaimed chunky, stretching his neck and eyeing the dish longingly.', true],
    ]);
  });

  it('keeps the take that says more even when it ends in a question', () => {
    expect(decide([clip('c', 0, [
      ...say('The boys look quite awake enough.', 1, 2.7), ...say('The boys look quite awake enough, but who can tell?', 4, 7.5),
    ])])).toEqual([
      ['The boys look quite awake enough.', false],
      ['The boys look quite awake enough, but who can tell?', true],
    ]);
  });

  it('ties a restart to its line when speech-to-text heard the first word differently', () => {
    expect(decide([clip('c', 0, [
      ...say('Little thing was all very well for these fellows who knew...', 1, 4),
      ...say('Loafing was all very well for these fellows who knew not mister vladimir.', 6, 10),
    ])])).toEqual([
      ['Little thing was all very well for these fellows who knew...', false],
      ['Loafing was all very well for these fellows who knew not mister vladimir.', true],
    ]);
  });

  it('splits an abandoned start off the sentence it ran on from', () => {
    const clips = [
      clip('a', 0, say('A prisoner, said the watchman, wants to...', 1, 4.5)),
      clip('b', 1, say('Wants to come out.', 0.5, 2)),
    ];
    expect(decide(clips)).toEqual([
      ['A prisoner, said the watchman,', true],
      ['wants to...', false],
      ['Wants to come out.', true],
    ]);
  });

  it('with a script, does not join an abandoned start to a take split by a pause', () => {
    expect(decide([clip('c', 0, [
      ...say('Cosette was no', 1, 2), ...say('Cosette was no longer in rags.', 2.7, 4.9), ...say('She was in mourning.', 5.5, 6.6),
    ])], ['Cosette was no longer in rags she was in mourning.'])).toEqual([
      ['Cosette was no', false],
      ['Cosette was no longer in rags.', true],
      ['She was in mourning.', true],
    ]);
  });

  it('with a script, keeps the rest of a line split off by punctuation or a long pause', () => {
    expect(decide([clip('c', 0, [
      ...say('Have you ever been in that place I was in last night?', 1, 4.6), ...say('asked Kirkland?', 4.9, 5.7),
    ])], ['Have you ever been in that place I was in last night asked kirkland.'])).toEqual([
      ['Have you ever been in that place I was in last night?', true],
      ['asked Kirkland?', true],
    ]);
    expect(decide([clip('c', 0, [...say('Inquired shaggy', 1, 2), ...say('in the metal forest.', 2.9, 4)])], ['Inquired shaggy in the metal forest.'])).toEqual([
      ['Inquired shaggy', true],
      ['in the metal forest.', true],
    ]);
  });
});
