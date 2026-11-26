import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { Transcript, type Word } from '@kilo/edl';
import { sidecarPathFor } from './ingest.js';
import { readPcm16 } from './silence.js';
import { flagFillers, norm } from './text.js';

export interface TranscribeInput {
  clipId: string;
  audioPath: string;
  durationSec: number;
}

export interface Transcriber {
  readonly name: 'deepgram' | 'openai' | 'fixture';
  transcribe(input: TranscribeInput): Promise<Transcript>;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: unknown }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

function cleanWords(words: Word[], durationSec: number): Word[] {
  const out: Word[] = [];
  for (const w of words) {
    const text = w.text.trim();
    if (!text) continue;
    let start = Math.max(0, w.start);
    let end = Math.max(start, w.end);
    if (durationSec > 0) {
      start = Math.min(start, durationSec);
      end = Math.min(end, durationSec);
    }
    // Keep words in time order and non-overlapping, as every later pass assumes.
    const prev = out[out.length - 1];
    if (prev && start < prev.end) {
      if (start < prev.start) start = prev.start;
      prev.end = Math.max(prev.start, Math.min(prev.end, start));
    }
    out.push({ ...w, text, start, end: Math.max(end, start) });
  }
  return flagFillers(out);
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!(err instanceof RetryableError) || i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
  throw last;
}

class RetryableError extends Error {}

async function checked(res: Awaited<ReturnType<FetchLike>>, what: string): Promise<unknown> {
  if (res.ok) return res.json();
  const body = (await res.text().catch(() => '')).slice(0, 300);
  const msg = `${what} returned ${res.status}: ${body}`;
  if (res.status === 429 || res.status >= 500) throw new RetryableError(msg);
  throw new Error(msg);
}

// ---- Deepgram --------------------------------------------------------------

interface DeepgramWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  confidence?: number;
}
interface DeepgramResponse {
  metadata?: { duration?: number };
  results?: {
    channels?: Array<{ detected_language?: string; alternatives?: Array<{ transcript?: string; words?: DeepgramWord[] }> }>;
  };
}

export function deepgramTranscriber(opts: { apiKey: string; fetch?: FetchLike; baseUrl?: string; model?: string }): Transcriber {
  const doFetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const base = (opts.baseUrl ?? 'https://api.deepgram.com').replace(/\/+$/, '');
  return {
    name: 'deepgram',
    async transcribe(input) {
      const audio = await readFile(input.audioPath);
      const params = new URLSearchParams({
        model: opts.model ?? 'nova-3',
        smart_format: 'true',
        punctuate: 'true',
        filler_words: 'true',
        language: 'en',
      });
      const json = (await withRetry(async () =>
        checked(
          await doFetch(`${base}/v1/listen?${params}`, {
            method: 'POST',
            headers: { Authorization: `Token ${opts.apiKey}`, 'Content-Type': 'audio/wav' },
            body: audio,
          }),
          'Deepgram',
        ),
      )) as DeepgramResponse;
      const channel = json.results?.channels?.[0];
      const alt = channel?.alternatives?.[0];
      const words: Word[] = (alt?.words ?? []).map((w) => ({
        text: w.punctuated_word ?? w.word,
        start: w.start,
        end: w.end,
        ...(typeof w.confidence === 'number' ? { confidence: Math.min(1, Math.max(0, w.confidence)) } : {}),
        filler: false,
      }));
      return Transcript.parse({
        clipId: input.clipId,
        language: (channel?.detected_language ?? 'en').slice(0, 2),
        durationSec: input.durationSec,
        words: cleanWords(words, input.durationSec),
      });
    },
  };
}

// ---- OpenAI-compatible -----------------------------------------------------

interface OpenAiWord {
  word: string;
  start: number;
  end: number;
}
interface OpenAiVerbose {
  text?: string;
  language?: string;
  duration?: number;
  words?: OpenAiWord[];
}

const LANGUAGE_CODES: Record<string, string> = { english: 'en', spanish: 'es', french: 'fr', german: 'de', portuguese: 'pt', italian: 'it' };

/**
 * The word list of verbose_json has no punctuation. Copies it back from the full
 * text by walking both in order; words that do not line up keep their plain form.
 */
export function restorePunctuation(words: OpenAiWord[], text: string): string[] {
  const pieces = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let p = 0;
  for (const w of words) {
    const target = norm(w.word).replace(/\s+/g, '');
    let found = -1;
    for (let k = p; k < Math.min(pieces.length, p + 4); k++) {
      if (norm(pieces[k]!).replace(/\s+/g, '') === target) {
        found = k;
        break;
      }
    }
    if (found >= 0) {
      out.push(pieces[found]!);
      p = found + 1;
    } else out.push(w.word);
  }
  return out;
}

/**
 * OpenAI-compatible endpoints refuse uploads over about 25 MB (13 minutes of the
 * 16 kHz mono WAV ingest writes). Stay a little under it.
 */
export const OPENAI_MAX_UPLOAD_BYTES = 24 * 1024 * 1024;

export interface AudioPiece {
  /** Position of the piece in the whole file, seconds. */
  start: number;
  end: number;
  /** A complete WAV file holding just this piece. */
  wav: Buffer;
}

function wavFile(samples: Int16Array, sampleRate: number): Buffer {
  const data = samples.length * 2;
  const buf = Buffer.alloc(44 + data);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + data, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(data, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i]!, 44 + i * 2);
  return buf;
}

/**
 * Splits a 16-bit PCM WAV into pieces of at most `maxBytes` each, cutting in the
 * quietest stretch near the end of each allowed span (a pause between words), so no
 * word is split in two. A file that already fits comes back whole and unchanged.
 */
export function splitWavOnSilences(wav: Buffer, maxBytes: number): AudioPiece[] {
  const pcm = readPcm16(wav);
  const { sampleRate, samples } = pcm;
  const total = samples.length;
  const durationSec = total / sampleRate;
  if (wav.length <= maxBytes) return [{ start: 0, end: durationSec, wav }];
  const maxSamples = Math.floor((maxBytes - 44) / 2);
  if (maxSamples < sampleRate) throw new Error(`maxBytes ${maxBytes} is too small to hold a second of audio`);
  // RMS energy of 20 ms windows, then a 300 ms moving sum: the quietest 300 ms is the cut.
  const win = Math.max(1, Math.round(sampleRate * 0.02));
  const energy = new Float64Array(Math.ceil(total / win));
  for (let w = 0; w < energy.length; w++) {
    let e = 0;
    const end = Math.min(total, (w + 1) * win);
    for (let i = w * win; i < end; i++) e += samples[i]! * samples[i]!;
    energy[w] = e;
  }
  const span = 15; // windows in 300 ms
  const pieces: AudioPiece[] = [];
  let start = 0;
  while (total - start > maxSamples) {
    // Look for the pause in the last 40% of what may go into this piece.
    const lo = Math.floor((start + maxSamples * 0.6) / win);
    const hi = Math.floor((start + maxSamples) / win) - span;
    let best = hi;
    let bestE = Infinity;
    let run = 0;
    for (let w = lo; w < lo + span; w++) run += energy[w] ?? 0;
    for (let w = lo; w <= hi; w++) {
      // Later windows win ties so pieces are as long as allowed.
      if (run <= bestE) {
        bestE = run;
        best = w;
      }
      run += (energy[w + span] ?? 0) - (energy[w] ?? 0);
    }
    const cut = Math.min(start + maxSamples, (best + Math.floor(span / 2)) * win);
    pieces.push({ start: start / sampleRate, end: cut / sampleRate, wav: wavFile(samples.subarray(start, cut), sampleRate) });
    start = cut;
  }
  pieces.push({ start: start / sampleRate, end: durationSec, wav: wavFile(samples.subarray(start), sampleRate) });
  return pieces;
}

export function openaiTranscriber(opts: {
  apiKey: string;
  fetch?: FetchLike;
  baseUrl?: string;
  model?: string;
  /** Largest upload the endpoint accepts; longer audio is sent in pieces cut on pauses. */
  maxUploadBytes?: number;
}): Transcriber {
  const doFetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const base = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const maxBytes = opts.maxUploadBytes ?? OPENAI_MAX_UPLOAD_BYTES;
  const send = (audio: Buffer, name: string) =>
    withRetry(async () => {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), name);
      form.append('model', opts.model ?? 'whisper-1');
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'word');
      form.append('language', 'en');
      // A disfluent prompt keeps the model from dropping filler words.
      form.append('prompt', 'Umm, so, uh, I was like, hmm... Okay. Um, here is what I, uh, think.');
      return checked(
        await doFetch(`${base}/audio/transcriptions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${opts.apiKey}` },
          body: form,
        }),
        'Transcription endpoint',
      );
    }) as Promise<OpenAiVerbose>;
  return {
    name: 'openai',
    async transcribe(input) {
      const audio = await readFile(input.audioPath);
      const pieces = splitWavOnSilences(audio, maxBytes);
      const words: Word[] = [];
      let language = 'en';
      for (const [k, piece] of pieces.entries()) {
        const name = pieces.length === 1 ? basename(input.audioPath) : basename(input.audioPath).replace(/(\.wav)?$/i, `.part${k + 1}.wav`);
        const json = await send(piece.wav, name);
        if (k === 0) language = (json.language ?? 'en').toLowerCase();
        const raw = json.words ?? [];
        const texts = restorePunctuation(raw, json.text ?? '');
        const len = piece.end - piece.start;
        raw.forEach((w, i) => {
          // Times come back relative to the piece; a word whose middle lies outside it is an echo of a neighbour.
          const mid = (w.start + w.end) / 2;
          if (pieces.length > 1 && (mid < -0.05 || mid > len + 0.05)) return;
          words.push({
            text: texts[i] ?? w.word,
            start: piece.start + Math.max(0, Math.min(len, w.start)),
            end: piece.start + Math.max(0, Math.min(len, w.end)),
            filler: false,
          });
        });
      }
      return Transcript.parse({
        clipId: input.clipId,
        language: LANGUAGE_CODES[language] ?? language.slice(0, 2),
        durationSec: input.durationSec,
        words: cleanWords(words, input.durationSec),
      });
    },
  };
}

// ---- fixture ---------------------------------------------------------------

/** Reads the sidecar ingest wrote from the fixture's comment tag (CONTRACTS.md section 4). */
export function fixtureTranscriber(): Transcriber {
  return {
    name: 'fixture',
    async transcribe(input) {
      let raw: string;
      try {
        raw = await readFile(sidecarPathFor(input.audioPath), 'utf8');
      } catch {
        return { clipId: input.clipId, language: 'en', durationSec: input.durationSec, words: [] };
      }
      const t = Transcript.parse(JSON.parse(raw));
      return { ...t, clipId: input.clipId, words: flagFillers(t.words) };
    },
  };
}

export function selectTranscriber(env: NodeJS.ProcessEnv = process.env, fetchImpl?: FetchLike): Transcriber {
  const choice =
    env.KILO_TRANSCRIBER ?? (env.DEEPGRAM_API_KEY ? 'deepgram' : env.OPENAI_API_KEY ? 'openai' : 'fixture');
  if (choice === 'deepgram') {
    if (!env.DEEPGRAM_API_KEY) throw new Error('KILO_TRANSCRIBER=deepgram needs DEEPGRAM_API_KEY');
    return deepgramTranscriber({ apiKey: env.DEEPGRAM_API_KEY, fetch: fetchImpl, baseUrl: env.DEEPGRAM_BASE_URL, model: env.KILO_DEEPGRAM_MODEL });
  }
  if (choice === 'openai') {
    if (!env.OPENAI_API_KEY) throw new Error('KILO_TRANSCRIBER=openai needs OPENAI_API_KEY');
    const max = Number(env.KILO_OPENAI_MAX_UPLOAD_BYTES);
    return openaiTranscriber({
      apiKey: env.OPENAI_API_KEY,
      fetch: fetchImpl,
      baseUrl: env.OPENAI_BASE_URL,
      model: env.KILO_OPENAI_TRANSCRIBE_MODEL,
      ...(Number.isFinite(max) && max > 0 ? { maxUploadBytes: max } : {}),
    });
  }
  if (choice === 'fixture') return fixtureTranscriber();
  throw new Error(`Unknown KILO_TRANSCRIBER: ${choice}`);
}
