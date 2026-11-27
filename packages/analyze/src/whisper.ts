import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transcript, type Word } from '@kilo/edl';
import { ChildFailedError, mediaTimeoutMs, spawnChecked } from './proc.js';
import { cleanWords, type Transcriber } from './transcribe.js';

/**
 * `KILO_TRANSCRIBER=whisper`: an open Whisper model on this machine's CPU, free and
 * offline once the model is downloaded. Runs `whisper/kilo_whisper.py` (faster-whisper,
 * CTranslate2 int8) once per clip on the 16 kHz WAV ingest wrote.
 *
 * Nothing else in Kilo needs Python or the model: they are looked for only when this
 * provider is chosen, and a missing piece fails the clip with a message that says how
 * to install it (`npm run whisper:setup` in packages/analyze).
 */

const here = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(here, '..');
export const WHISPER_SCRIPT = join(PKG, 'whisper', 'kilo_whisper.py');
/** Where `npm run whisper:setup` puts the virtual environment and the model (gitignored). */
export const DEFAULT_WHISPER_VENV = join(PKG, '.work', 'whisper-venv');
export const DEFAULT_WHISPER_CACHE_DIR = join(PKG, '.work', 'whisper-models');
/**
 * base.en: the smallest model whose word timings and filler retention held up on the
 * real-speech recordings (fixtures/real/README.md); about 0.15 s of CPU per second of audio
 * on two threads.
 */
export const DEFAULT_WHISPER_MODEL = 'base.en';
export const DEFAULT_WHISPER_THREADS = 2;

export interface WhisperOptions {
  /** Python with faster-whisper installed. */
  python: string;
  /** A model name (`base.en`, `small.en`, ...), a Hugging Face repo id, or a local model directory. */
  model: string;
  cacheDir: string;
  threads: number;
  /** Replaces the disfluent prompt that keeps fillers; "" sends none. */
  prompt?: string;
  /** Let the script fetch a missing model from Hugging Face (off by default: a worker should not download on the job path). */
  allowDownload: boolean;
}

export function whisperOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): WhisperOptions {
  const venvPython = join(DEFAULT_WHISPER_VENV, 'bin', 'python');
  const threads = Number(env.KILO_WHISPER_THREADS);
  return {
    python: env.KILO_WHISPER_PYTHON || (existsSync(venvPython) ? venvPython : 'python3'),
    model: env.KILO_WHISPER_MODEL || DEFAULT_WHISPER_MODEL,
    cacheDir: env.KILO_WHISPER_CACHE_DIR || DEFAULT_WHISPER_CACHE_DIR,
    threads: Number.isInteger(threads) && threads > 0 ? threads : DEFAULT_WHISPER_THREADS,
    ...(env.KILO_WHISPER_PROMPT !== undefined ? { prompt: env.KILO_WHISPER_PROMPT } : {}),
    allowDownload: env.KILO_WHISPER_ALLOW_DOWNLOAD === '1',
  };
}

/** The setup is incomplete (no Python, no faster-whisper, no model): says what to install. */
export class WhisperSetupError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'WhisperSetupError';
  }
}

const SETUP_HINT = 'Run `npm run whisper:setup` in packages/analyze (or see server/Dockerfile), or set KILO_WHISPER_PYTHON and KILO_WHISPER_CACHE_DIR.';

interface ScriptWord {
  text: string;
  start: number;
  end: number;
  probability?: number;
}
interface ScriptLine {
  error?: string;
  message?: string;
  file?: string;
  language?: string;
  words?: ScriptWord[];
  loadSec?: number;
  transcribeSec?: number;
}

/** Parses the script's JSON lines: the last result, or a WhisperSetupError for a reported error. */
export function parseWhisperOutput(stdout: string, opts: Pick<WhisperOptions, 'model' | 'cacheDir' | 'python'>): ScriptLine {
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'));
  const parsed: ScriptLine[] = [];
  for (const l of lines) {
    try {
      parsed.push(JSON.parse(l) as ScriptLine);
    } catch {
      /* a stray line from a library; ignore */
    }
  }
  const err = parsed.find((p) => p.error);
  if (err) {
    const what =
      err.error === 'model_missing'
        ? `The Whisper model "${opts.model}" is not downloaded to ${opts.cacheDir}.`
        : err.error === 'missing_python_package'
          ? `faster-whisper is not installed for ${opts.python}.`
          : `Whisper failed (${err.error}).`;
    throw new WhisperSetupError(`${what} ${SETUP_HINT} Detail: ${err.message ?? ''}`.trim(), err.error!);
  }
  const result = parsed.filter((p) => Array.isArray(p.words)).pop();
  if (!result) throw new Error('Whisper printed no result');
  return result;
}

/** Turns the script's words into Kilo words: fillers flagged by the shared lexicon, times cleaned. */
export function whisperWords(words: readonly ScriptWord[], durationSec: number): Word[] {
  const out: Word[] = words.map((w) => ({
    text: w.text,
    start: w.start,
    end: w.end,
    ...(typeof w.probability === 'number' ? { confidence: Math.min(1, Math.max(0, w.probability)) } : {}),
    filler: false,
  }));
  return cleanWords(out, durationSec);
}

export function whisperTranscriber(opts: WhisperOptions = whisperOptionsFromEnv()): Transcriber {
  return {
    name: 'whisper',
    async transcribe(input) {
      if (!existsSync(WHISPER_SCRIPT)) throw new WhisperSetupError(`Missing ${WHISPER_SCRIPT}.`, 'missing_script');
      const args = [
        '-I', WHISPER_SCRIPT,
        '--model', opts.model,
        '--cache-dir', opts.cacheDir,
        '--threads', String(opts.threads),
        ...(opts.prompt !== undefined ? ['--prompt', opts.prompt] : []),
        ...(opts.allowDownload ? ['--allow-download'] : []),
        input.audioPath,
      ];
      let stdout: string;
      try {
        // Model load plus decoding: allow the media rule's time (10 s per second of audio, 3 min floor).
        const r = await spawnChecked(opts.python, args, { timeoutMs: mediaTimeoutMs(input.durationSec) + 60_000, maxBuffer: 64 << 20 });
        stdout = r.stdout.toString('utf8');
      } catch (err) {
        if (err instanceof ChildFailedError) {
          if (/^Could not start/.test(err.message) && /ENOENT/.test(err.message)) {
            throw new WhisperSetupError(`No Python at "${opts.python}" for KILO_TRANSCRIBER=whisper. ${SETUP_HINT}`, 'missing_python');
          }
          // The script reports setup problems as a JSON line (also on stderr) and exits 2.
          if (/"error"/.test(err.stderr)) parseWhisperOutput(err.stderr, opts);
          if (/No module named/.test(err.stderr)) {
            throw new WhisperSetupError(`A Python package is missing for ${opts.python}. ${SETUP_HINT}`, 'missing_python_package');
          }
        }
        throw err;
      }
      const result = parseWhisperOutput(stdout, opts);
      return Transcript.parse({
        clipId: input.clipId,
        language: (result.language ?? 'en').slice(0, 2),
        durationSec: input.durationSec,
        words: whisperWords(result.words ?? [], input.durationSec),
      });
    },
  };
}
