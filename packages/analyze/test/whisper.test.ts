import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SilenceGap, Word } from '@kilo/edl';
import { afterAll, describe, expect, it } from 'vitest';
import { describeProviders } from '../src/analyze.js';
import { selectTranscriber, transcriberChoice } from '../src/transcribe.js';
import {
  EXCERPT_CLIP_SUFFIX, CLIP_EDGE_LEAN_SEC, continuedIslands, dropWordsOverSilence, SOFT_END_SEC, SOFT_START_SEC, WhisperSetupError, inventedWords, isLikelyHallucination, leanIntoPauses, parseWhisperOutput, refineWordTimes, sparseIslands, speechIslands,
  whisperOptionsFromEnv, whisperTranscriber, whisperWords, type WhisperRaw,
} from '../src/whisper.js';

const WORK = join(import.meta.dirname, '..', '.work', 'test-whisper');
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

const w = (text: string, start: number, end: number): Word => ({ text, start, end, filler: false });
const gap = (start: number, end: number): SilenceGap => ({ clipId: 'c', start, end });
const times = (ws: Word[]) => ws.map((x) => [x.text, +x.start.toFixed(3), +x.end.toFixed(3)]);

/** A 16 kHz mono 16-bit WAV of `sec` seconds: quiet noise, with a loud tone where `loud` says. */
function wav(path: string, sec: number, loud: Array<[number, number]>): void {
  const sr = 16000;
  const n = Math.round(sec * sr);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  let seed = 7;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const t = i / sr;
    const on = loud.some(([a, b]) => t >= a && t < b);
    const v = (seed / 0x7fffffff - 0.5) * 60 + (on ? 8000 * Math.sin(2 * Math.PI * 180 * t) : 0);
    buf.writeInt16LE(Math.round(v), 44 + i * 2);
  }
  writeFileSync(path, buf);
}

describe('whisper transcriber: choosing it', () => {
  it('is chosen only by name; the default order is unchanged', () => {
    expect(transcriberChoice({})).toBe('fixture');
    expect(transcriberChoice({ DEEPGRAM_API_KEY: 'x' })).toBe('deepgram');
    expect(transcriberChoice({ KILO_TRANSCRIBER: 'whisper' })).toBe('whisper');
    expect(selectTranscriber({ KILO_TRANSCRIBER: 'whisper' }).name).toBe('whisper');
    const p = describeProviders({ KILO_TRANSCRIBER: 'whisper', KILO_WHISPER_MODEL: 'small.en' });
    expect(p.transcriber).toMatchObject({ name: 'whisper', real: true });
    expect(p.transcriber.detail).toContain('small.en');
  });

  it('reads its settings from the environment', () => {
    const o = whisperOptionsFromEnv({ KILO_WHISPER_PYTHON: '/opt/py', KILO_WHISPER_MODEL: 'small.en', KILO_WHISPER_CACHE_DIR: '/cache', KILO_WHISPER_THREADS: '3', KILO_WHISPER_ALLOW_DOWNLOAD: '1' });
    expect(o).toMatchObject({ python: '/opt/py', model: 'small.en', cacheDir: '/cache', threads: 3, allowDownload: true });
    const d = whisperOptionsFromEnv({ KILO_WHISPER_PROMPT: '', KILO_WHISPER_MODEL: '' });
    expect(d).toMatchObject({ model: 'base.en', threads: 2, allowDownload: false });
    expect(d.prompt).toBeUndefined();
    expect(whisperOptionsFromEnv({ KILO_WHISPER_PROMPT: 'none' }).prompt).toBe('');
  });
});

describe('whisper transcriber: setup errors', () => {
  it('names what is missing', () => {
    expect(() => parseWhisperOutput('{"error": "model_missing", "message": "not here"}\n', { model: 'base.en', cacheDir: '/m', python: 'py' })).toThrow(
      /The Whisper model "base.en" is not downloaded to \/m\. Run `npm run whisper:setup`/,
    );
    expect(() => parseWhisperOutput('{"error": "missing_python_package", "message": "x"}', { model: 'base.en', cacheDir: '/m', python: '/usr/bin/py' })).toThrow(
      /faster-whisper is not installed for \/usr\/bin\/py/,
    );
    expect(() => parseWhisperOutput('noise\n', { model: 'base.en', cacheDir: '/m', python: 'py' })).toThrow(/printed no result/);
  });

  it('fails a clip with a setup message when Python is not there', async () => {
    const t = whisperTranscriber({ python: '/nonexistent/python3', model: 'base.en', cacheDir: '/none', threads: 1, allowDownload: false });
    const err = await t.transcribe({ clipId: 'c', audioPath: '/none.wav', durationSec: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WhisperSetupError);
    expect((err as Error).message).toMatch(/No Python at "\/nonexistent\/python3".*whisper:setup/);
  });

  let python3 = true;
  try {
    execFileSync('python3', ['-c', 'pass']);
  } catch {
    python3 = false;
  }
  it.runIf(python3)('fails a clip with a setup message when the model is not downloaded (no network)', async () => {
    mkdirSync(WORK, { recursive: true });
    const audio = join(WORK, 'a.wav');
    wav(audio, 1, []);
    // Either Python has no faster-whisper, or it has one and the empty cache has no model: both say so.
    const t = whisperTranscriber({ python: 'python3', model: 'base.en', cacheDir: join(WORK, 'empty-cache'), threads: 1, allowDownload: false });
    const err = await t.transcribe({ clipId: 'c', audioPath: audio, durationSec: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WhisperSetupError);
    expect(['missing_python_package', 'model_missing']).toContain((err as WhisperSetupError).code);
  }, 60_000);
});

describe('whisper transcriber: words', () => {
  it('drops likely hallucinations and echoes, and flags fillers', () => {
    expect(isLikelyHallucination({ text: 'guard.', start: 28.12, end: 28.22, probability: 0.079 })).toBe(true);
    expect(isLikelyHallucination({ text: 'questions.', start: 30, end: 30, probability: 0.01 })).toBe(true);
    expect(isLikelyHallucination({ text: '-', start: 3, end: 3.08, probability: 0.5 })).toBe(true);
    expect(isLikelyHallucination({ text: 'Little', start: 3, end: 3.5, probability: 0.05 })).toBe(false);
    const out = whisperWords([
      { text: 'Um,', start: 0.2, end: 0.4, probability: 0.9 },
      { text: 'the', start: 0.5, end: 0.6, probability: 0.99 },
      { text: 'border.', start: 0.6, end: 0.9, probability: 0.95 },
      { text: 'order.', start: 0.9, end: 1.2, probability: 0.4 },
      { text: 'word.', start: 1.3, end: 1.5, probability: 1 },
      { text: 'Vladimir.', start: 1.5, end: 1.55, probability: 0.97 },
      { text: 'mirror.', start: 1.55, end: 1.75, probability: 0.3 },
      { text: 'that,', start: 1.8, end: 1.9, probability: 0.9 },
      { text: 'that', start: 1.9, end: 2.0, probability: 0.49 },
      { text: 'guard.', start: 2.1, end: 2.2, probability: 0.05 },
    ], 3);
    expect(times(out)).toEqual([['Um,', 0.2, 0.4], ['the', 0.5, 0.6], ['border.', 0.6, 1.2], ['word.', 1.3, 1.5], ['Vladimir.', 1.5, 1.75], ['that,', 1.8, 1.9], ['that', 1.9, 2]]);
    expect(out[0]!.filler).toBe(true);
  });

  it('runs the script output through the same cleaning when given a runner', async () => {
    mkdirSync(WORK, { recursive: true });
    const audio = join(WORK, 'b.wav');
    wav(audio, 3, [[0.5, 1.2], [1.8, 2.4]]);
    const t = whisperTranscriber(whisperOptionsFromEnv({}), async () => ({
      language: 'en',
      words: [{ text: 'Hello', start: 0.3, end: 1.0, probability: 0.9 }, { text: 'there.', start: 1.0, end: 2.4, probability: 0.9 }],
    }));
    const tr = await t.transcribe({ clipId: 'c1', audioPath: audio, durationSec: 3 });
    expect(tr.clipId).toBe('c1');
    // "Hello" moves to its sound (0.5-1.2), its start leaned into the lead-in (at most 0.2 s, half of it);
    // "there.", stretched back over the pause, starts where its sound does (1.8), leaned a little into the pause.
    expect(tr.words[0]!.start).toBeGreaterThan(0.25);
    expect(tr.words[0]!.start).toBeLessThan(0.55);
    expect(tr.words[0]!.end).toBeGreaterThan(1.15);
    expect(tr.words[0]!.end).toBeLessThan(1.3);
    expect(tr.words[1]!.start).toBeGreaterThan(1.7);
    expect(tr.words[1]!.start).toBeLessThan(1.85);
  }, 60_000);
});

describe('whisper transcriber: word times moved to the audio', () => {
  it('pulls an edge out of a silence and pushes an early end out to the silence after it', () => {
    // "seen." ends 340 ms early; "The" starts 600 ms early, inside the pause.
    expect(times(refineWordTimes([w('have', 17.4, 17.56), w('seen.', 17.56, 17.82), w('The', 20.22, 20.94)], [gap(18.13, 20.8)], 30))).toEqual([
      // The last word, with no silence after it, leans 100 ms late.
      ['have', 17.4, 17.56], ['seen.', 17.56, 18.13], ['The', 20.8, 21.04],
    ]);
  });

  it('gives sound in a gap Whisper left between words, with no silence in it, to the word before', () => {
    expect(times(refineWordTimes([w('himself,', 40.34, 40.66), w('but', 41.3, 41.44)], [], 50))).toEqual([['himself,', 40.34, 41.3], ['but', 41.3, 41.54]]);
  });

  it('leans an end late when no silence says where it is', () => {
    expect(times(refineWordTimes([w('apologies.', 32.86, 33.42), w('I', 36, 36.2)], [], 50))).toEqual([['apologies.', 32.86, 33.52], ['I', 36, 36.3]]);
  });

  it('keeps the side of a pause inside a word that holds the speech', () => {
    const speech = (a: number, b: number) => Math.max(0, Math.min(b, 31.02) - Math.max(a, 30.2));
    expect(times(refineWordTimes([w('an', 30.2, 30.32), w('ambulance."', 30.32, 31.9)], [gap(31.5, 31.82)], 40, speech))).toEqual([
      ['an', 30.2, 30.32], ['ambulance."', 30.32, 31.5],
    ]);
  });

  it('moves a word Whisper put in a pause to the start of the next word', () => {
    // "None" sits in room tone; "of" is stretched over "None of".
    const speech = (a: number, b: number) => Math.max(0, Math.min(b, 15.1) - Math.max(a, 13.95));
    expect(times(refineWordTimes([w('None', 11.06, 11.5), w('of', 11.5, 14.34), w('you', 14.34, 14.46)], [gap(13.225, 13.505)], 20, speech))).toEqual([
      ['None', 13.505, 13.922], ['of', 13.922, 14.34], ['you', 14.34, 14.56],
    ]);
  });

  it('puts the first word of a sentence run on across a pause after the pause', () => {
    expect(times(refineWordTimes([w('heavy.', 26.78, 27.06), w('It', 27.06, 27.88), w('hasn\'t', 27.88, 30.14)], [gap(27.295, 29.289)], 40))).toEqual([
      ['heavy.', 26.78, 27.295], ['It', 29.289, 29.524], ['hasn\'t', 29.524, 30.24],
    ]);
  });
});

describe('whisper transcriber: words it wrote without hearing them', () => {
  const sw = (text: string, start: number, end: number, probability = 0.95) => ({ text, start, end, probability });

  it('drops a run of words with no duration, the end of a sentence finished at a window seam', () => {
    const raw = [
      sw('The', 29.16, 29.58), sw('sun,', 29.58, 29.82),
      ...'as you see, tells quite another story.'.split(' ').map((t) => sw(t, 29.98, 29.98)),
      sw('as', 29.98, 30.06), sw('you', 30.06, 30.14), sw('see,', 30.14, 30.36),
    ];
    expect([...inventedWords(raw)].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(whisperWords(raw, 40).map((x) => x.text)).toEqual(['The', 'sun,', 'as', 'you', 'see,']);
    // One short word on its own stays.
    expect(inventedWords([sw('a', 3, 3.01), sw('cat.', 3.01, 3.4)]).size).toBe(0);
  });

  it('drops unlikely words packed faster than anyone speaks: an echo of the words before', () => {
    const raw = [sw('It', 27.32, 27.42), sw('was', 27.42, 27.52), sw('Christmas.', 27.52, 27.78), sw('This', 27.78, 27.86, 0.1), sw('is', 27.86, 27.94, 0.48), sw('Christmas.', 27.94, 27.96, 0.42)];
    expect(whisperWords(raw, 30).map((x) => x.text)).toEqual(['It', 'was', 'Christmas.']);
    // Likely words said fast are the speaker's.
    expect(inventedWords([sw('gonna', 1, 1.08), sw('go.', 1.08, 1.12)]).size).toBe(0);
  });

  it('folds an almost certainly unheard word that rhymes with the long word before into it', () => {
    const out = whisperWords([sw('and', 25, 25.44), sw('mortification.', 25.44, 25.96, 1), sw('presentation.', 25.96, 26.28, 0.02), sw('These', 26.6, 26.86)], 30);
    expect(times(out)).toEqual([['and', 25, 25.44], ['mortification.', 25.44, 26.28], ['These', 26.6, 26.86]]);
  });

  it('puts the first word of a restart that Whisper ran into the pause before it after the pause', () => {
    const ws = 'Harry gave his farewells with Harry gave his farewells with deep regret.'.split(' ');
    const t = [[10.36, 10.66], [10.66, 10.96], [10.96, 11.14], [11.14, 11.94], [11.94, 12.14], [12.14, 13.12], [13.12, 14.24], [14.24, 14.5], [14.5, 15.2], [15.2, 15.4], [15.4, 15.8], [15.8, 16.3]];
    const out = refineWordTimes(ws.map((x, i) => w(x, t[i]![0]!, t[i]![1]!)), [gap(12.29, 13.63)], 20);
    expect(out[4]!.end).toBeCloseTo(12.29, 2);
    // "Harry" now opens the take after the pause, with "gave".
    expect(out[5]!.start).toBeCloseTo(13.63, 2);
    expect(out[6]!.start).toBeGreaterThan(out[5]!.end - 1e-9);
  });
});

describe('whisper transcriber: a second look at stretches it got wrong', () => {
  it('finds the stretches of speech and the ones that hold too few letters for their speech', () => {
    const speech = (a: number, b: number) => [[1, 3], [4, 6], [7, 9]].reduce((n, [x, y]) => n + Math.max(0, Math.min(b, y!) - Math.max(a, x!)), 0);
    const islands = speechIslands(speech, 10);
    expect(islands.map((x) => [+x.start.toFixed(1), +x.end.toFixed(1)])).toEqual([[1, 3], [4, 6], [7, 9]]);
    const words = [w('All', 1, 1.4), w('afternoon', 1.4, 2.2), w('he', 2.2, 2.4), w('sat', 2.4, 2.9), w('in', 4, 4.9), w('room.', 4.9, 6),
      w('Morning', 7, 7.6), w('prayers', 7.6, 8.3), w('ran', 8.3, 9)];
    expect(sparseIslands(words, islands).map((x) => +x.start.toFixed(2))).toEqual([4]);
  });

  it('transcribes a sparse stretch again on its own and takes the words when they say clearly more', async () => {
    mkdirSync(WORK, { recursive: true });
    const audio = join(WORK, 'second-look.wav');
    wav(audio, 10, [[1, 3], [4, 6], [7, 9]]);
    const calls: string[] = [];
    const t = whisperTranscriber(whisperOptionsFromEnv({}), async (input): Promise<WhisperRaw> => {
      calls.push(input.clipId);
      if (input.clipId.endsWith(EXCERPT_CLIP_SUFFIX)) {
        // The excerpt starts 0.3 s before the stretch (at 3.7 s).
        return { words: 'All afternoon he sat in the room.'.split(' ').map((x, i) => ({ text: x, start: 0.3 + i * 0.28, end: 0.3 + (i + 1) * 0.28, probability: 0.9 })) };
      }
      return {
        words: [['All', 1, 1.4], ['afternoon', 1.4, 2.2], ['he', 2.2, 2.4], ['sat', 2.4, 2.9], ['in', 3.1, 4.9], ['room.', 4.9, 6],
          ['Morning', 7, 7.6], ['prayers', 7.6, 8.3], ['ran.', 8.3, 9]].map(([text, start, end]) => ({ text: text as string, start: start as number, end: end as number, probability: 0.9 })),
      };
    });
    const tr = await t.transcribe({ clipId: 'c2', audioPath: audio, durationSec: 10 });
    expect(calls).toEqual(['c2', `c2${EXCERPT_CLIP_SUFFIX}`]);
    expect(tr.words.map((x) => x.text).join(' ')).toBe('All afternoon he sat All afternoon he sat in the room. Morning prayers ran.');
    expect(tr.words[4]!.start).toBeGreaterThan(3.9);
  }, 60_000);
});

describe('whisper transcriber: edges at a pause', () => {
  it('leans the edges that sit on a pause a little into it, never past a third of it', () => {
    const out = leanIntoPauses([w('rails.', 39.8, 40.2), w('The', 40.9, 41.2), w('end.', 41.2, 41.5), w('So', 41.65, 41.8)], [gap(40.2, 40.9), gap(41.5, 41.65)]);
    expect(times(out)).toEqual([['rails.', 39.8, +(40.2 + SOFT_END_SEC).toFixed(3)], ['The', +(40.9 - SOFT_START_SEC).toFixed(3), 41.2], ['end.', 41.2, 41.5], ['So', 41.65, 41.8]]);
    // A pause just over one the decider reads (0.45 s between utterances) stays over it.
    const near = leanIntoPauses([w('upon,', 5, 5.5), w('whereas', 6, 6.4)], [gap(5.5, 6)]);
    expect(near[1]!.start - near[0]!.end).toBeGreaterThanOrEqual(0.45);
    // At the clip's start and end it leans further, into at most half the lead-in or tail.
    const edges = leanIntoPauses([w('What', 0.8, 1.1), w('then.', 1.1, 1.5)], [gap(0, 0.8), gap(1.5, 1.7)], 1.7);
    expect(times(edges)).toEqual([['What', +(0.8 - CLIP_EDGE_LEAN_SEC).toFixed(3), 1.1], ['then.', 1.1, 1.6]]);
  });
});

describe('whisper transcriber: stretches that lost their opening, words over silence', () => {
  it('finds a stretch that opens mid-sentence after a long pause', () => {
    const islands = [{ start: 1, end: 3, speechSec: 2 }, { start: 4, end: 8, speechSec: 4 }, { start: 8.4, end: 9, speechSec: 0.6 }];
    const words = [w('Ye', 1, 1.3), w('keep', 1.3, 1.8), w('watch,', 1.8, 2.4), w('so', 2.5, 2.9), w('that', 4, 4.5), w('nor', 4.5, 8), w('night.', 8.4, 9)];
    expect(continuedIslands(words, islands).map((x) => x.start)).toEqual([4]);
    // After a full stop it is a new sentence; after a short pause it is a reading pause.
    expect(continuedIslands([...words.slice(0, 3), w('so.', 2.5, 2.9), ...words.slice(4)], islands)).toEqual([]);
  });

  it('drops a word laid over the silence after the last thing said, keeps one with speech under it', () => {
    const speech = (a: number, b: number) => Math.max(0, Math.min(b, 26.85) - Math.max(a, 25)) + Math.max(0, Math.min(b, 31) - Math.max(a, 30));
    const raw = [{ text: 'another.', start: 26.38, end: 26.72 }, { text: 'The', start: 26.72, end: 28.04, probability: 0.62 }, { text: 'Now.', start: 30, end: 31 }];
    expect(dropWordsOverSilence(raw, speech, 40).map((x) => x.text)).toEqual(['another.', 'Now.']);
    // The same word right before the next word is moved later, not dropped.
    expect(dropWordsOverSilence([raw[0]!, { ...raw[1]!, end: 29.5 }, raw[2]!], speech, 40).length).toBe(3);
  });
});

