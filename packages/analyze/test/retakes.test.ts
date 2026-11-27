import { describe, expect, it } from 'vitest';
import { buildChunks, prepareClipWords } from '../src/chunks.js';
import { enumeration, heuristicCuts, slotDifferences } from '../src/heuristic.js';
import { keys } from '../src/text.js';
import { decideInput, synthClip, type UnitSpec } from './helpers.js';

/** Utterances of one clip with the heuristic's keep and reason for each. */
function decide(units: UnitSpec[]): Array<[string, boolean | undefined, string | undefined]> {
  const clips = [synthClip('c', 0, units)];
  const cw = prepareClipWords(clips.map((c) => c.info), clips.map((c) => c.transcript));
  const chunks = buildChunks(cw);
  const d = heuristicCuts({ chunks, clipWords: cw, settings: decideInput(clips).settings });
  return chunks.map((c) => [c.text, d.get(c.id)?.keep, d.get(c.id)?.reason]);
}

describe('retakes and parallel lines', () => {
  it('keeps a list of lines that share a frame and differ in the slot', () => {
    expect(decide([
      { say: 'No gym, no equipment, twenty minutes.' }, { pause: 1.2 },
      { say: 'Squats for one minute.' }, { say: 'Push ups for one minute.' },
      { say: 'Lunges for one,' }, { say: 'wait, that came out wrong' }, { pause: 1 },
      { say: 'Lunges for one minute.' },
    ])).toEqual([
      ['No gym, no equipment, twenty minutes.', true, 'speech'],
      ['Squats for one minute.', true, 'speech'],
      ['Push ups for one minute.', true, 'speech'],
      ['Lunges for one,', false, 'false_start'],
      ['wait, that came out wrong', false, 'off_script'],
      ['Lunges for one minute.', true, 'speech'],
    ]);
  });

  it('ties an abandoned start to the one line it begins, not to every line with the same first word', () => {
    expect(decide([
      { say: 'The cushion,' }, { say: 'wait, no' }, { pause: 0.8 },
      { say: 'The cushion is still soft at the heel.' }, { say: 'The grip is fine on wet roads.' },
    ]).map(([t, k]) => [t, k])).toEqual([
      ['The cushion,', false], ['wait, no', false], ['The cushion is still soft at the heel.', true], ['The grip is fine on wet roads.', true],
    ]);
    expect(decide([
      { say: 'The first one is about habits.' }, { say: 'The second,' }, { say: 'wait, no' }, { pause: 0.6 },
      { say: 'The second is about money and patience.' },
    ]).map(([t, k]) => [t, k])).toEqual([
      ['The first one is about habits.', true], ['The second,', false], ['wait, no', false], ['The second is about money and patience.', true],
    ]);
  });

  it('an abandoned start that is a complete take of nothing yet still joins the finished take, not another fragment', () => {
    expect(decide([
      { say: 'The trick is to apply it on damp skin' }, { pause: 0.7 }, { say: 'The trick is to apply it on' }, { pause: 0.5 },
      { say: 'The trick is to apply it on damp skin.' },
    ]).map(([, k]) => k)).toEqual([false, false, true]);
  });

  it('lines whose only difference is one slot are a list, even when they share most content words', () => {
    expect(decide([
      { say: 'This brush is for short hair.' }, { pause: 0.9 }, { say: 'This brush is for' }, { pause: 0.9 },
      { say: 'This brush is for long hair.' },
    ]).map(([, k]) => k)).toEqual([true, false, true]);
  });

  it('still finds exact, shortened and reworded retakes', () => {
    expect(decide([{ say: 'You only need a pea sized amount.' }, { pause: 0.6 }, { say: 'You only need a pea sized amount.' }]).map(([, k]) => k))
      .toEqual([false, true]);
    expect(decide([{ say: 'Honestly it changed my whole morning.' }, { pause: 0.8 }, { say: 'Honestly, it changed my entire morning routine.' }])
      .map(([, k, r]) => [k, r])).toEqual([[false, 'retake'], [true, 'speech']]);
    expect(decide([{ say: 'Wednesday is a long run.' }, { pause: 1.3 }, { say: 'Wednesday is an easy long run.' }]).map(([, k]) => k))
      .toEqual([false, true]);
  });

  it('a changed number or word is a retake when a correction or restart follows the first take, and the correction is cut', () => {
    expect(decide([
      { say: 'The price is twenty dollars.' }, { pause: 0.7 }, { say: 'wait, is it twenty or thirty dollars?' }, { pause: 2 },
      { say: 'The price is thirty dollars.' },
    ])).toEqual([
      ['The price is twenty dollars.', false, 'retake'],
      ['wait, is it twenty or thirty dollars?', false, 'off_script'],
      ['The price is thirty dollars.', true, 'speech'],
    ]);
    expect(decide([
      { say: 'The first thing I do is drink coffee.' }, { pause: 0.8 }, { say: "no, it's water, not coffee" }, { pause: 1.4 },
      { say: 'The first thing I do is drink water.' },
    ]).map(([, k]) => k)).toEqual([false, false, true]);
    // With no marker, a changed number is a different line.
    expect(decide([{ say: 'The jacket was six dollars.' }, { say: 'The jacket was eight dollars.' }]).map(([, k]) => k)).toEqual([true, true]);
  });

  it('a restart marker belongs to the take right after it, not to a later parallel line', () => {
    expect(decide([
      { say: 'A pot of yogurt with berries.' }, { pause: 0.6 }, { say: 'wait, let me redo that' }, { pause: 1 },
      { say: 'A pot of greek yogurt with frozen berries.' }, { say: 'A pot of hummus with carrots.' },
    ]).map(([, k]) => k)).toEqual([false, false, true, true]);
  });

  it('the same list slot twice is a retake; different slots are different lines', () => {
    expect(decide([
      { say: 'Step one, wet your hair.' }, { pause: 1 }, { say: 'Step two, wet your hair.' }, { pause: 0.9 },
      { say: 'Step two, wet the brush.' },
    ]).map(([, k]) => k)).toEqual([true, false, true]);
  });

  it('keeps a line the speaker says again on purpose after moving on', () => {
    expect(decide([
      { say: 'Stop washing your face twice a day.' }, { pause: 1 }, { say: 'Your skin needs its oils.' }, { pause: 1 },
      { say: 'Once at night is plenty.' }, { pause: 1 }, { say: 'Seriously, stop washing your face twice a day.' },
    ]).every(([, k]) => k)).toBe(true);
  });

  it('prefers the statement over the same line said back as a question', () => {
    expect(decide([
      { say: 'It lasts all week on one charge.' }, { pause: 1 }, { say: 'It lasts all week on one charge?' },
    ]).map(([, k]) => k)).toEqual([true, false]);
  });

  it('reads list slots and slot differences', () => {
    expect(enumeration(keys('Step two, wet the brush.'))).toBe(2);
    expect(enumeration(keys('The second is about money.'))).toBe(2);
    expect(enumeration(keys('Day three, read for twenty minutes.'))).toBe(3);
    expect(enumeration(keys('Squats for one minute.'))).toBeNull();
    expect(slotDifferences(keys('Squats for one minute.'), keys('Lunges for one minute.'))).toEqual([{ a: ['squat'], b: ['lunge'] }]);
    expect(slotDifferences(keys('Try it for one month.'), keys('Just try it for one month and see.'))).toEqual([]);
  });
});
