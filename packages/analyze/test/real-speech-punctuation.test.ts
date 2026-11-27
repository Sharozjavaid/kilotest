import type { ClipInfo, Transcript, Word } from '@kilo/edl';
import { MODE_PRESETS } from '@kilo/edl';
import { describe, expect, it } from 'vitest';
import { buildChunks, prepareClipWords } from '../src/chunks.js';
import { heuristicCuts, restartsOpening } from '../src/heuristic.js';
import { flagFillers } from '../src/text.js';

/**
 * Whisper's punctuation and segmentation on the real-speech recordings (fixtures/real), and the
 * decider's reading of it: a full stop on an abandoned start, parallel phrases that open alike,
 * script lines joined across takes, and the filler lexicon on a read "Ah". Times are the ones
 * Whisper (with the CTC check) gave on the recordings each case comes from.
 */

type W = [text: string, start: number, end: number];

function clip(id: string, order: number, words: W[]): { info: ClipInfo; transcript: Transcript } {
  const durationSec = Math.ceil((words[words.length - 1]?.[2] ?? 0) + 1);
  return {
    info: { id, order, durationSec, fps: 30, width: 1080, height: 1920 },
    transcript: { clipId: id, language: 'en', durationSec, words: words.map(([text, start, end]): Word => ({ text, start, end, filler: false })) },
  };
}

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

describe('a restart outweighs a full stop', () => {
  it('reads a line said again word for word and carried on as a restart', () => {
    expect(restartsOpening(['to', 'say', 'nothing', 'said', 'montalai'], ['to', 'say', 'nothing', 'said', 'montalai', 'so', 'that'])).toBe(true);
    expect(restartsOpening(['since', 'when'], ['since', 'when', 'ha', 'malady'])).toBe(true);
    expect(restartsOpening(['step', 'one'], ['step', 'two', 'wet', 'your', 'hair'])).toBe(false);
    expect(restartsOpening(['i', 'obeyed'], ['i', 'declared', 'myself', 'quite', 'willing'])).toBe(false);
  });

  it('cuts an abandoned start closed with a full stop when the next utterance restarts it', () => {
    // final_7127
    expect(decide([clip('c', 0, [
      ...say('To say nothing, said Montalais.', 8.43, 10.17),
      ...say('To say nothing, said Montalais, so that when Mademoiselle thinks...', 11.02, 16),
      ...say('To say nothing, said Montalais, so that when Mademoiselle thinks, Athenais is the only one who knows it.', 17.35, 25.26),
    ])]).map((x) => x[1])).toEqual([false, false, true]);
    // final_4507: a two-word start closed with a question mark
    expect(decide([clip('c', 0, [
      ...say('Since when?', 17.41, 18.35),
      ...say('Since when has malady', 19.9, 21.73),
      ...say('Since when has malady banished medicine?', 22.76, 26.11),
    ])]).map((x) => x[1])).toEqual([false, false, true]);
  });

  it('keeps the take that says the most when every take of the line was restarted (final_7729)', () => {
    expect(decide([clip('c', 0, [
      ...say('He continued his pretended.', 26.67, 28.45),
      ...say('He continued his pretended search and to give...', 30.08, 33.91),
      ...say('He continued his pretended search and to give...', 34.81, 37.69),
      ...say('color to his errand, made two arrests.', 38.09, 41.18),
    ])]).map((x) => x[1])).toEqual([false, false, true, true]);
  });

  it('keeps two finished sentences that only share a first word', () => {
    expect(decide([clip('c', 0, [...say('Step one.', 1, 1.8), ...say('Step two, wet your hair.', 2.6, 4.4)])]).map((x) => x[1])).toEqual([true, true]);
  });
});

describe('restarts and parallel phrases', () => {
  it('ties a one-word start written with a comma to the restart, though its pause looks short (other_8131)', () => {
    const out = decide([clip('c', 0, [
      ...say('But,', 12.7, 13.77),
      ...say('but the Stonewall gang,', 14.02, 15.4),
      ...say('but the Stonewall gang is backing Wayne.', 16.41, 18.71),
    ])]);
    expect(out.filter((x) => x[1]).map((x) => x[0])).toEqual(['but the Stonewall gang is backing Wayne.']);
  });

  it('keeps parallel phrases that open alike but change a word (other_2414, other_4294)', () => {
    expect(decide([clip('c', 0, [
      ...say('O eternal everywhere', 24.82, 26.46),
      ...say('o eternal nowhere', 26.9, 28.58),
      ...say('o eternal in vain.', 29.01, 30.69),
    ])]).map((x) => x[1])).toEqual([true, true, true]);
    expect(decide([clip('c', 0, [
      ...say('You will then have only a pair of trousers a waistcoat a hat', 8.66, 12.01),
      ...say('and a coat', 12.48, 13.04),
      ...say('and my boots.', 13.86, 14.78),
    ])]).map((x) => x[1])).toEqual([true, true, true]);
  });

  it('still cuts an abandoned start whose words speech-to-text ran together (fresh_2412)', () => {
    expect(decide([clip('c', 0, [
      ...say('The menwers...', 16.06, 17.68),
      ...say('The men were as handsome as the women beautiful.', 17.93, 20.61),
    ])]).map((x) => x[1])).toEqual([false, true]);
  });

  it('cuts every piece of an abandoned attempt that the kept take says again (other_4852)', () => {
    expect(decide([clip('c', 0, [
      ...say('Then he said,', 12.77, 13.53),
      ...say('I do know.', 14.52, 15.37),
      ...say('Then he said,', 16.3, 17.38),
      ...say('well, I do not care for it.', 17.83, 19.86),
      ...say('I cannot say that I do.', 20.12, 21.29),
    ])]).map((x) => x[1])).toEqual([false, false, true, true, true]);
  });

  it('reads "No, no, no." as one phrase, not as "No," and an aside (final_2094)', () => {
    const out = decide([clip('c', 0, [
      ...say('No, no, no.', 13.25, 14.96),
      ...say("Tottie'll get her feet wet.", 14.96, 16.45),
      ...say('No, no, no.', 17.75, 19.44),
      ...say("Tottie'll get her feet wet.", 19.44, 21.01),
    ])]);
    expect(out).toEqual([
      ['No, no, no.', false],
      ["Tottie'll get her feet wet.", false],
      ['No, no, no.', true],
      ["Tottie'll get her feet wet.", true],
    ]);
  });
});

describe('script lines', () => {
  it('does not join a take of one line to the next line as its lead-in (final_237)', () => {
    const script = ['There there he said soothingly patting her brown fuzzy head.', 'Asked Phronsie in intense interest slipping down out of her arms.'];
    const out = decide([
      clip('p2', 0, [...say('There there he', 1.04, 2.27), ...say('Asked Phronsie in intense interest slipping down out of her arms.', 2.97, 9.32)]),
      clip('p3', 1, say('There there he said soothingly patting her brown fuzzy head.', 1.14, 5.01)),
    ], script);
    expect(out.map((x) => x[1])).toEqual([false, true, true]);
  });

  it('does not join a restart of the opening into the first take (final_672)', () => {
    const script = ['And the whole night the tree stood still and in deep thought.'];
    const out = decide([clip('c', 0, [
      ...say('And the whole night', 17, 17.95),
      ...say('the tree stood still', 18.47, 19.82),
      ...say('And the whole night', 21.09, 22.04),
      ...say('the tree stood still and in deep thought.', 22.56, 25.3),
    ])], script);
    expect(out.map((x) => x[1])).toEqual([false, false, true, true]);
  });

  it('joins the two halves of a line that repeat a figure of speech (heldout_2803)', () => {
    const script = ['Think of lady glenarvan think of mary grant.'];
    expect(decide([clip('c', 0, [...say('Think of lady Glenarvan', 1.41, 3.15), ...say('think of Mary Grant.', 3.4, 4.96)])], script).map((x) => x[1])).toEqual([true, true]);
  });
});

describe('the filler lexicon', () => {
  const words = (ws: W[]): Word[] => ws.map(([text, start, end]) => ({ text, start, end, filler: false }));
  it('keeps a sentence-opening "Ah" that runs straight on, and cuts hesitation', () => {
    expect(flagFillers(words([['Ah,', 5.25, 5.6], ['the', 5.62, 5.75], ['swamp.', 5.78, 6.3]]))[0]!.filler).toBe(false);
    expect(flagFillers(words([['said', 1, 1.3], ['Dickie.', 1.32, 1.8], ['Ah', 3, 3.3], ['said', 3.35, 3.6]]))[2]!.filler).toBe(false);
    // Mid-sentence, alone, or before a pause: hesitation.
    expect(flagFillers(words([['I', 1, 1.1], ['was,', 1.12, 1.4], ['ah,', 1.6, 1.8], ['thinking', 1.9, 2.3]]))[2]!.filler).toBe(true);
    expect(flagFillers(words([['Ah.', 1, 1.3]]))[0]!.filler).toBe(true);
    expect(flagFillers(words([['Ah,', 1, 1.3], ['so', 1.9, 2.1]]))[0]!.filler).toBe(true);
    // "Um" and "uh" are always fillers, even opening a sentence.
    expect(flagFillers(words([['Um,', 1, 1.3], ['the', 1.32, 1.5], ['swamp.', 1.52, 2]]))[0]!.filler).toBe(true);
    expect(flagFillers(words([['Uh', 1, 1.3], ['so', 1.32, 1.5], ['today', 1.52, 2]]))[0]!.filler).toBe(true);
  });
});
