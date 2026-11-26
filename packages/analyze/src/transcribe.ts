import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { Transcript, type Word } from '@kilo/edl';
import { sidecarPathFor } from './ingest.js';
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

export function openaiTranscriber(opts: { apiKey: string; fetch?: FetchLike; baseUrl?: string; model?: string }): Transcriber {
  const doFetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const base = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  return {
    name: 'openai',
    async transcribe(input) {
      const audio = await readFile(input.audioPath);
      const json = (await withRetry(async () => {
        const form = new FormData();
        form.append('file', new Blob([audio], { type: 'audio/wav' }), basename(input.audioPath));
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
      })) as OpenAiVerbose;
      const raw = json.words ?? [];
      const texts = restorePunctuation(raw, json.text ?? '');
      const words: Word[] = raw.map((w, i) => ({ text: texts[i] ?? w.word, start: w.start, end: w.end, filler: false }));
      const lang = (json.language ?? 'en').toLowerCase();
      return Transcript.parse({
        clipId: input.clipId,
        language: LANGUAGE_CODES[lang] ?? lang.slice(0, 2),
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
    return openaiTranscriber({ apiKey: env.OPENAI_API_KEY, fetch: fetchImpl, baseUrl: env.OPENAI_BASE_URL, model: env.KILO_OPENAI_TRANSCRIBE_MODEL });
  }
  if (choice === 'fixture') return fixtureTranscriber();
  throw new Error(`Unknown KILO_TRANSCRIBER: ${choice}`);
}
