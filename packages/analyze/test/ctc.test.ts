import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Word } from '@kilo/edl';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CTC_END_HOLD_SEC, CtcSetupError, ctcGreedyWords, dropUnheard, ctcKey, holdCtcEdges, pairWithCtc, parseCtcOutput, runCtcScript,
  type CtcEmissions, type CtcWord,
} from '../src/ctc.js';
import { whisperOptionsFromEnv, whisperTranscriber } from '../src/whisper.js';

const WORK = join(import.meta.dirname, '..', '.work', 'test-ctc');
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

const VOCAB = ['<pad>', '<s>', '</s>', '<unk>', '|', ...'ETAONIHSRDLUMWCFGYPBVK\'XJQZ'.split('')];
const c = (text: string, start: number, end: number): CtcWord => ({ text, start, end });
const w = (text: string, start: number, end: number): Word => ({ text, start, end, filler: false });

/** Emissions that spell `frames` (one symbol per 20 ms frame: a letter, '|' or '_' for blank). */
function emissions(frames: string): CtcEmissions {
  const V = VOCAB.length;
  const lp = new Float32Array(frames.length * V).fill(-20);
  [...frames].forEach((ch, i) => {
    const v = ch === '_' ? 0 : VOCAB.indexOf(ch);
    lp[i * V + v] = -0.01;
  });
  return { frameSec: 0.02, vocab: VOCAB, blank: 0, frames: frames.length, logprobs: lp };
}

/** The script's JSON line for those emissions, float16 as the script sends it. */
function scriptLine(e: CtcEmissions): string {
  const buf = Buffer.alloc(2 * e.logprobs.length);
  // -0.01 and -20 in IEEE half precision.
  e.logprobs.forEach((x, i) => buf.writeUInt16LE(x > -1 ? 0xa11f : 0xcd00, 2 * i));
  return JSON.stringify({ file: 'a.wav', frameSec: 0.02, vocab: e.vocab, blank: 0, frames: e.frames, logprobs: buf.toString('base64'), cpuSec: 0.5 });
}

describe('CTC check: reading the model', () => {
  it('collapses repeats and blanks and splits words at the separator, with frame times', () => {
    const words = ctcGreedyWords(emissions('__HH_E___|_|NNO_|___NO__')).map((x) => c(x.text, +x.start.toFixed(3), +x.end.toFixed(3)));
    expect(words).toEqual([c('HE', 0.04, 0.12), c('NO', 0.24, 0.3), c('NO', 0.4, 0.44)]);
    // A letter said twice with a blank between is two letters ("LL" in "ALL").
    expect(ctcGreedyWords(emissions('AL_L')).map((x) => x.text)).toEqual(['ALL']);
  });

  it('reads the script output, half precision included', () => {
    const e = parseCtcOutput(`noise\n${scriptLine(emissions('_HI_|'))}\n`, '/m');
    expect(e.frames).toBe(5);
    expect(e.cpuSec).toBe(0.5);
    expect(e.logprobs[1 * VOCAB.length + VOCAB.indexOf('H')]).toBeCloseTo(-0.01, 3);
    expect(e.logprobs[0]).toBeCloseTo(-0.01, 3);
    expect(e.logprobs[1]).toBe(-20);
    expect(ctcGreedyWords(e).map((x) => [x.text, +x.start.toFixed(3), +x.end.toFixed(3)])).toEqual([['HI', 0.02, 0.06]]);
  });

  it('names what is missing', async () => {
    expect(() => parseCtcOutput('{"error": "model_missing", "message": "x"}', '/m')).toThrow(/CTC model .* not downloaded to \/m\. Run `npm run whisper:setup`/);
    expect(() => parseCtcOutput('nothing', '/m')).toThrow(/printed no result/);
    const err = await runCtcScript({ python: '/nonexistent/python3', cacheDir: '/m', threads: 1, allowDownload: false })({ clipId: 'c', audioPath: '/x.wav', durationSec: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CtcSetupError);
    expect((err as Error).message).toMatch(/No Python at "\/nonexistent\/python3"/);
  });

  it('is on unless KILO_WHISPER_ALIGN=none', () => {
    expect(whisperOptionsFromEnv({}).align).toBe('ctc');
    expect(whisperOptionsFromEnv({ KILO_WHISPER_ALIGN: '' }).align).toBe('ctc');
    expect(whisperOptionsFromEnv({ KILO_WHISPER_ALIGN: 'none' }).align).toBe('none');
  });
});

describe('CTC check: Whisper against what was heard', () => {
  it('pairs words by spelling and time, the nearer copy of a repeat first', () => {
    expect(ctcKey("Don't,")).toBe("DON'T");
    const words = [w('The', 1.0, 1.1), w('trick', 1.1, 1.5), w('is', 2.9, 3.0)];
    const ctc = [c('THE', 0.2, 0.3), c('TRICK', 0.3, 0.6), c('THE', 1.0, 1.1), c('TRICK', 1.15, 1.45), c('IS', 2.9, 3.0)];
    expect(pairWithCtc(words, ctc)).toEqual([2, 3, 4]);
    // Unlike spellings never pair, however near.
    expect(pairWithCtc([w('search', 1, 1.5)], [c('SURGE', 1, 1.5)])).toEqual([-1]);
    expect(pairWithCtc([w('Consay!', 1, 3)], [c('CONSEIL', 2.1, 2.7)])).toEqual([0]);
  });

  it('drops a word laid over a stretch where nothing was heard, keeps fillers and short merges', () => {
    // "glow. So..." with "So" over the silence after "glow".
    const ctc = [c('TAWNY', 20.6, 20.94), c('GLOW', 21.02, 21.26), c('THEN', 23.0, 23.2)];
    const words = [
      { text: 'tawny', start: 20.46, end: 20.94 }, { text: 'glow.', start: 20.94, end: 21.12 }, { text: 'So...', start: 21.12, end: 21.41 },
      { text: 'um,', start: 21.6, end: 21.9 }, { text: 'Then', start: 23.0, end: 23.2 },
    ];
    expect(dropUnheard(words, ctc).map((x) => x.text)).toEqual(['tawny', 'glow.', 'um,', 'Then']);
    // "It wasn't" heard as one word "TWASN'T" right after "Jasper": too short a stretch to say nothing was said.
    const merged = dropUnheard(
      [{ text: 'Jasper.', start: 11.7, end: 12.6 }, { text: 'It', start: 12.66, end: 12.66 }, { text: "wasn't", start: 12.66, end: 12.92 }],
      [c('JASPER', 12.04, 12.44), c("TWASN'T", 12.66, 12.94)],
    );
    expect(merged.map((x) => x.text)).toEqual(['Jasper.', 'It', "wasn't"]);
    // Whisper wrote one word as two: the part the CTC heard inside its neighbour stays.
    const split = dropUnheard(
      [{ text: 'northwest', start: 8.62, end: 8.94 }, { text: 'word,', start: 8.94, end: 9.58 }, { text: 'a', start: 9.98, end: 10.12 }],
      [c('NORTHWESTWARD', 8.74, 9.66), c('A', 10.12, 10.14)],
    );
    expect(split.map((x) => x.text)).toEqual(['northwest', 'word,', 'a']);
    // A dropped word that closed the sentence leaves its full stop behind.
    const closed = dropUnheard(
      [{ text: 'provide', start: 7.74, end: 7.94 }, { text: 'for', start: 7.94, end: 8.34 }, { text: 'her.', start: 8.34, end: 8.56 }, { text: 'Then', start: 9.5, end: 9.7 }],
      [c('PROVIDE', 7.8, 8.12), c('FOR', 8.2, 8.42), c('THEN', 9.5, 9.7)],
    );
    expect(closed.map((x) => x.text)).toEqual(['provide', 'for.', 'Then']);
  });

  it('keeps Whisper where both sides disagree (a name, a number)', () => {
    const words = [{ text: 'Dittones', start: 14.5, end: 14.8 }, { text: '-Chiron', start: 14.8, end: 15.2 }];
    expect(dropUnheard(words, [c('TONACHERANT', 14.74, 15.4)]).map((x) => x.text)).toEqual(['Dittones', '-Chiron']);
  });

  it('never leaves a kept edge inside the CTC span, and holds a little past it', () => {
    // "consciences." ended at 42.44 by Whisper; the CTC heard letters until 42.78.
    const out = holdCtcEdges([w('sore', 41.7, 41.92), w('consciences.', 41.92, 42.44), w('Next', 45, 45.3)], [c('SORE', 41.84, 42.08), c('CONSCIENCES', 42.16, 42.78), c('NEXT', 45.05, 45.3)], 50);
    expect(out[1]!.end).toBeCloseTo(42.78 + CTC_END_HOLD_SEC, 6);
    // Never into the next word, and the next word's start is held before its first letter.
    const tight = holdCtcEdges([w('a', 1, 1.1), w('b', 1.12, 1.3)], [c('A', 1.0, 1.1), c('B', 1.14, 1.3)], 5);
    expect(tight[0]!.end).toBeLessThanOrEqual(tight[1]!.start);
    expect(tight[1]!.start).toBeLessThanOrEqual(1.14);
    // A pause never drops below a decider threshold it reached: 1.01 s stays at 1 s or more.
    const floored = holdCtcEdges([w('end.', 1, 1.2), w('Next', 2.21, 2.5)], [c('END', 1.0, 1.4), c('NEXT', 2.3, 2.5)], 5, [0.45, 1]);
    expect(floored[1]!.start - floored[0]!.end).toBeGreaterThanOrEqual(1);
    expect(floored[0]!.end).toBeGreaterThan(1.2);
    // A word whose edges are already outside its span is left alone.
    expect(holdCtcEdges([w('x', 0.5, 2)], [c('X', 1, 1.2)], 3)).toEqual([w('x', 0.5, 2)]);
  });

  it('runs inside the whisper transcriber when asked', async () => {
    mkdirSync(WORK, { recursive: true });
    const audio = join(WORK, 'a.wav');
    // One second of 16 kHz audio, with a loud tone at 0.3-0.7 s.
    const n = 16000;
    const buf = Buffer.alloc(44 + 2 * n);
    buf.write('RIFF', 0, 'ascii');
    buf.writeUInt32LE(36 + 2 * n, 4);
    buf.write('WAVEfmt ', 8, 'ascii');
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(16000, 24);
    buf.writeUInt32LE(32000, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36, 'ascii');
    buf.writeUInt32LE(2 * n, 40);
    for (let i = 0; i < n; i++) {
      const t = i / 16000;
      buf.writeInt16LE(Math.round((((i * 7919) % 61) - 30) + (t >= 0.3 && t < 0.7 ? 8000 * Math.sin(2 * Math.PI * 180 * t) : 0)), 44 + 2 * i);
    }
    writeFileSync(audio, buf);
    const opts = { ...whisperOptionsFromEnv({}), align: 'ctc' as const };
    const whisper = async () => ({ language: 'en', words: [{ text: 'Ghost.', start: 0.3, end: 0.7, probability: 0.9 }] });
    // Over sound, Whisper's word stays without the check...
    expect((await whisperTranscriber({ ...opts, align: 'none' }, whisper).transcribe({ clipId: 'c', audioPath: audio, durationSec: 1 })).words.map((x) => x.text)).toEqual(['Ghost.']);
    // ...and goes when the model heard no letter in the whole clip.
    const t = whisperTranscriber(opts, whisper, async () => emissions('_'.repeat(50)));
    expect((await t.transcribe({ clipId: 'c', audioPath: audio, durationSec: 1 })).words).toEqual([]);
    // When it heard the word, its edges are held around the letters.
    const heard = whisperTranscriber(opts, whisper, async () => emissions('_'.repeat(17) + 'GHOST' + '_'.repeat(28)));
    const [g] = (await heard.transcribe({ clipId: 'c', audioPath: audio, durationSec: 1 })).words;
    expect(g!.start).toBeLessThanOrEqual(0.34);
    expect(g!.end).toBeGreaterThanOrEqual(0.44 + CTC_END_HOLD_SEC - 1e-6);
  }, 60_000);
});
