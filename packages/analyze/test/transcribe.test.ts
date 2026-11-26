import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Transcript } from '@kilo/edl';
import {
  deepgramTranscriber, fixtureTranscriber, openaiTranscriber, restorePunctuation, selectTranscriber, type FetchLike,
} from '../src/transcribe.js';
import { flagFillers } from '../src/text.js';

function tinyWav(dir: string): string {
  const samples = 1600;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(samples * 2, 40);
  const p = join(dir, 'audio.wav');
  writeFileSync(p, buf);
  return p;
}

interface Call {
  url: string;
  init: { method: string; headers: Record<string, string>; body: unknown };
}

function mockFetch(responses: Array<{ status: number; body: unknown }>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  };
  return { fetch, calls };
}

/** Shape of a real Deepgram pre-recorded response (nova-3, smart_format, filler_words). */
const DEEPGRAM_RESPONSE = {
  metadata: {
    transaction_key: 'deprecated',
    request_id: '4c1b6f1e-0b6b-4a59-9a8d-3d2f1d0d8a11',
    sha256: '154e291ecfa8be6ab8343560bcc109008fa7853eb5372533e8efdefc9b504c33',
    created: '2025-06-02T10:00:00.000Z',
    duration: 4.2,
    channels: 1,
    models: ['2187e11a-3532-4498-b076-81fa530bdd49'],
    model_info: { '2187e11a-3532-4498-b076-81fa530bdd49': { name: 'general-nova-3', version: '2024-12-20.0', arch: 'nova-3' } },
  },
  results: {
    channels: [
      {
        alternatives: [
          {
            transcript: 'Um, so this serum is honestly the best.',
            confidence: 0.98,
            words: [
              { word: 'um', start: 0.24, end: 0.56, confidence: 0.91, punctuated_word: 'Um,' },
              { word: 'so', start: 0.72, end: 0.88, confidence: 0.99, punctuated_word: 'so' },
              { word: 'this', start: 0.88, end: 1.04, confidence: 0.99, punctuated_word: 'this' },
              { word: 'serum', start: 1.04, end: 1.44, confidence: 0.97, punctuated_word: 'serum' },
              { word: 'is', start: 1.44, end: 1.6, confidence: 0.99, punctuated_word: 'is' },
              { word: 'honestly', start: 1.6, end: 2.08, confidence: 0.98, punctuated_word: 'honestly' },
              { word: 'the', start: 2.08, end: 2.2, confidence: 0.99, punctuated_word: 'the' },
              { word: 'best', start: 2.2, end: 2.6, confidence: 0.99, punctuated_word: 'best.' },
            ],
          },
        ],
      },
    ],
  },
};

/** Shape of an OpenAI verbose_json transcription with word timestamps. */
const OPENAI_RESPONSE = {
  task: 'transcribe',
  language: 'english',
  duration: 4.2,
  text: 'Uh, it takes ten seconds, and it, like, actually works.',
  words: [
    { word: 'Uh', start: 0.0, end: 0.32 },
    { word: 'it', start: 0.5, end: 0.62 },
    { word: 'takes', start: 0.62, end: 0.9 },
    { word: 'ten', start: 0.9, end: 1.1 },
    { word: 'seconds', start: 1.1, end: 1.6 },
    { word: 'and', start: 1.8, end: 1.92 },
    { word: 'it', start: 1.92, end: 2.04 },
    { word: 'like', start: 2.1, end: 2.3 },
    { word: 'actually', start: 2.4, end: 2.8 },
    { word: 'works', start: 2.8, end: 3.2 },
  ],
  segments: [{ id: 0, seek: 0, start: 0, end: 3.2, text: ' Uh, it takes ten seconds, and it, like, actually works.', tokens: [1, 2], temperature: 0, avg_logprob: -0.2, compression_ratio: 1.1, no_speech_prob: 0.01 }],
};

describe('deepgram transcriber', () => {
  it('posts the audio with filler words on and maps punctuated words', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kilo-dg-'));
    const { fetch, calls } = mockFetch([{ status: 200, body: DEEPGRAM_RESPONSE }]);
    const t = await deepgramTranscriber({ apiKey: 'dg-test', fetch }).transcribe({ clipId: 'c1', audioPath: tinyWav(dir), durationSec: 4.2 });
    expect(Transcript.parse(t)).toBeTruthy();
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe('https://api.deepgram.com/v1/listen');
    expect(url.searchParams.get('filler_words')).toBe('true');
    expect(url.searchParams.get('punctuate')).toBe('true');
    expect(calls[0]!.init.headers.Authorization).toBe('Token dg-test');
    expect(calls[0]!.init.headers['Content-Type']).toBe('audio/wav');
    expect(Buffer.isBuffer(calls[0]!.init.body)).toBe(true);
    expect(t.clipId).toBe('c1');
    expect(t.words.map((w) => w.text)).toEqual(['Um,', 'so', 'this', 'serum', 'is', 'honestly', 'the', 'best.']);
    expect(t.words[0]).toMatchObject({ start: 0.24, end: 0.56, filler: true, confidence: 0.91 });
    expect(t.words.filter((w) => w.filler)).toHaveLength(1);
  });

  it('retries a 503 then succeeds, and fails clearly on 401', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kilo-dg-'));
    const audioPath = tinyWav(dir);
    const ok = mockFetch([{ status: 503, body: { err: 'busy' } }, { status: 200, body: DEEPGRAM_RESPONSE }]);
    const t = await deepgramTranscriber({ apiKey: 'k', fetch: ok.fetch }).transcribe({ clipId: 'c1', audioPath, durationSec: 4.2 });
    expect(ok.calls).toHaveLength(2);
    expect(t.words).toHaveLength(8);
    const bad = mockFetch([{ status: 401, body: { err_code: 'INVALID_AUTH' } }]);
    await expect(deepgramTranscriber({ apiKey: 'k', fetch: bad.fetch }).transcribe({ clipId: 'c1', audioPath, durationSec: 4.2 })).rejects.toThrow(/401/);
    expect(bad.calls).toHaveLength(1);
  });
});

describe('openai transcriber', () => {
  it('asks for word timestamps, honours OPENAI_BASE_URL, restores punctuation and flags fillers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kilo-oa-'));
    const { fetch, calls } = mockFetch([{ status: 200, body: OPENAI_RESPONSE }]);
    const transcriber = selectTranscriber(
      { KILO_TRANSCRIBER: 'openai', OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: 'https://stt.example.com/v1/' },
      fetch,
    );
    expect(transcriber.name).toBe('openai');
    const t = await transcriber.transcribe({ clipId: 'c9', audioPath: tinyWav(dir), durationSec: 4.2 });
    expect(calls[0]!.url).toBe('https://stt.example.com/v1/audio/transcriptions');
    expect(calls[0]!.init.headers.Authorization).toBe('Bearer sk-test');
    const form = calls[0]!.init.body as FormData;
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.getAll('timestamp_granularities[]')).toEqual(['word']);
    expect(form.get('file')).toBeInstanceOf(Blob);
    expect(t.language).toBe('en');
    expect(t.words.map((w) => w.text)).toEqual(['Uh,', 'it', 'takes', 'ten', 'seconds,', 'and', 'it,', 'like,', 'actually', 'works.']);
    expect(t.words.filter((w) => w.filler).map((w) => w.text)).toEqual(['Uh,', 'like,']);
  });

  it('restorePunctuation tolerates words missing from the text', () => {
    expect(restorePunctuation([{ word: 'hello', start: 0, end: 1 }, { word: 'there', start: 1, end: 2 }], 'Hello, world.')).toEqual(['Hello,', 'there']);
  });
});

describe('fixture transcriber and selection', () => {
  it('reads the sidecar and swaps in the real clip id; no sidecar gives no words', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kilo-fx-'));
    const audioPath = tinyWav(dir);
    expect((await fixtureTranscriber().transcribe({ clipId: 'real', audioPath, durationSec: 1 })).words).toEqual([]);
    writeFileSync(join(dir, 'audio.words.json'), JSON.stringify({ clipId: 'placeholder', language: 'en', durationSec: 1, words: [{ text: 'um', start: 0.1, end: 0.3 }, { text: 'Hi.', start: 0.4, end: 0.6, filler: false }] }));
    const t = await fixtureTranscriber().transcribe({ clipId: 'real', audioPath, durationSec: 1 });
    expect(t.clipId).toBe('real');
    expect(t.words.map((w) => [w.text, w.filler])).toEqual([['um', true], ['Hi.', false]]);
  });

  it('picks providers from the environment as CONTRACTS.md says', () => {
    expect(selectTranscriber({}).name).toBe('fixture');
    expect(selectTranscriber({ OPENAI_API_KEY: 'x' }).name).toBe('openai');
    expect(selectTranscriber({ OPENAI_API_KEY: 'x', DEEPGRAM_API_KEY: 'y' }).name).toBe('deepgram');
    expect(selectTranscriber({ DEEPGRAM_API_KEY: 'y', KILO_TRANSCRIBER: 'fixture' }).name).toBe('fixture');
    expect(() => selectTranscriber({ KILO_TRANSCRIBER: 'deepgram' })).toThrow(/DEEPGRAM_API_KEY/);
  });

  it('flags soft fillers only when set off by commas', () => {
    const w = (text: string, i: number) => ({ text, start: i, end: i + 0.5, filler: false });
    const flagged = flagFillers(['I', 'like', 'it,', 'and', 'it,', 'like,', 'works.', 'Um', 'yes.'].map(w));
    expect(flagged.filter((x) => x.filler).map((x) => x.text)).toEqual(['like,', 'Um']);
  });
});
