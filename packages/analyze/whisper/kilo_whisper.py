#!/usr/bin/env python3
"""Local speech-to-text for Kilo's `whisper` transcriber (packages/analyze/src/whisper.ts).

Runs an open Whisper model on the CPU with faster-whisper (CTranslate2, int8) and prints
one JSON object per input file on stdout, one per line:

  {"file": ..., "language": "en", "durationSec": ..., "words": [{"text", "start", "end", "probability"}],
   "loadSec": ..., "transcribeSec": ..., "cpuSec": ...}

cpuSec is the process's CPU time (all threads, user + system) spent on that file.

Errors are printed (on stdout and stderr) as {"error": <code>, "message": <text>} and exit with status 2 so the
Node side can tell the user exactly what to install. Nothing here touches the network
unless --allow-download is given; the model must already be in --cache-dir otherwise.

Usage:
  kilo_whisper.py --model base.en --cache-dir DIR [--threads 2] [--prompt TEXT] [--language en] [--allow-download] FILE...
  kilo_whisper.py --model base.en --cache-dir DIR --download-only
"""
import argparse
import json
import os
import resource
import sys
import time

# Systran's CTranslate2 conversions of OpenAI's Whisper weights (MIT), pinned so a model
# update upstream cannot change the cuts silently. Other names are passed through as-is
# (a Hugging Face repo id or a local directory).
PINNED = {
    'tiny.en': ('Systran/faster-whisper-tiny.en', None),
    'base.en': ('Systran/faster-whisper-base.en', '3d3d5dee26484f91867d81cb899cfcf72b96be6c'),
    'small.en': ('Systran/faster-whisper-small.en', 'd1d751a5f8271d482d14ca55d9e2deeebbae577f'),
    'base': ('Systran/faster-whisper-base', None),
    'small': ('Systran/faster-whisper-small', None),
    # OpenAI's large-v3-turbo (MIT), already quantized to int8 for CTranslate2 (814 MB instead of
    # 1.6 GB in float16), from a community conversion: multilingual.
    'large-v3-turbo': ('Zoont/faster-whisper-large-v3-turbo-int8-ct2', '846f74797293e5f605d509a6ab5395a1f2f2874e'),
}

# Whisper learned to tidy speech up; a disfluent prompt makes it write the "um"s and "uh"s
# it hears instead of dropping them (measured in fixtures/real/README.md).
DEFAULT_PROMPT = 'Umm, so, uh, I was like, hmm... Okay. Um, here is what I, uh, think.'


def fail(code: str, message: str) -> None:
    line = json.dumps({'error': code, 'message': message})
    print(line, flush=True)
    print(line, file=sys.stderr, flush=True)  # the caller keeps stderr when the exit status is not 0
    sys.exit(2)


def resolve_model(name: str, cache_dir: str, allow_download: bool) -> str:
    if os.path.isdir(name):
        return name
    try:
        from faster_whisper.utils import download_model
    except ImportError as e:  # pragma: no cover - reported to the user
        fail('missing_python_package', f'faster-whisper is not installed for {sys.executable}: {e}')
    repo, rev = PINNED.get(name, (name, None))
    try:
        return download_model(repo, cache_dir=cache_dir, local_files_only=not allow_download, revision=rev)
    except Exception as e:  # huggingface_hub raises several types for "not in the cache"
        if allow_download:
            fail('model_download_failed', f'Could not download {repo}: {e}')
        fail('model_missing', f'Whisper model "{name}" ({repo}) is not in {cache_dir}: {type(e).__name__}')
    return ''


def load_wav(path: str):
    """Reads a 16-bit PCM WAV (what ingest writes) as 16 kHz mono float32, without PyAV.

    faster-whisper's own decoder needs PyAV, whose newer releases it does not support yet;
    Kilo always hands this script the 16 kHz mono WAV ingest wrote, so read that directly.
    """
    import wave

    import numpy as np

    try:
        with wave.open(path, 'rb') as w:
            rate, channels, width, n = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
            raw = w.readframes(n)
    except (wave.Error, EOFError) as e:
        fail('unsupported_audio', f'{path} is not a PCM WAV file: {e}')
    if width != 2:
        fail('unsupported_audio', f'{path} is {8 * width}-bit; expected 16-bit PCM')
    x = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768.0
    if channels > 1:
        x = x.reshape(-1, channels).mean(axis=1)
    if rate != 16000:
        # Linear resampling is enough for speech-to-text input; ingest already writes 16 kHz.
        t = np.arange(0, len(x) / rate, 1 / 16000.0)
        x = np.interp(t, np.arange(len(x)) / rate, x).astype(np.float32)
    return x


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default='base.en')
    ap.add_argument('--cache-dir', required=True)
    ap.add_argument('--threads', type=int, default=2)
    ap.add_argument('--prompt', default=None, help='initial prompt; "" for none')
    ap.add_argument('--beam-size', type=int, default=5)
    ap.add_argument('--language', default=None, help='language code; default: English for an .en model, else detected')
    ap.add_argument('--allow-download', action='store_true')
    ap.add_argument('--download-only', action='store_true')
    ap.add_argument('files', nargs='*')
    a = ap.parse_args()

    t0 = time.time()
    path = resolve_model(a.model, a.cache_dir, a.allow_download or a.download_only)
    if a.download_only:
        print(json.dumps({'model': a.model, 'path': path}), flush=True)
        return
    try:
        from faster_whisper import WhisperModel
    except ImportError as e:
        fail('missing_python_package', f'faster-whisper is not installed for {sys.executable}: {e}')
    model = WhisperModel(path, device='cpu', compute_type='int8', cpu_threads=max(1, a.threads), num_workers=1)
    load_sec = time.time() - t0
    prompt = DEFAULT_PROMPT if a.prompt is None else (a.prompt or None)
    english_only = a.model.endswith('.en') or path.rstrip('/').endswith('.en')

    def cpu() -> float:
        r = resource.getrusage(resource.RUSAGE_SELF)
        return r.ru_utime + r.ru_stime

    for f in a.files:
        t1 = time.time()
        c1 = cpu()
        segments, info = model.transcribe(
            load_wav(f),
            language=a.language or ('en' if english_only else None),
            beam_size=a.beam_size,
            word_timestamps=True,
            initial_prompt=prompt,
            # Each window stands alone: carrying text forward makes Whisper repeat itself
            # over long pauses and lets the prompt's style fade, which drops fillers again.
            condition_on_previous_text=False,
            vad_filter=False,
        )
        words = []
        for seg in segments:
            for w in seg.words or []:
                text = w.word.strip()
                if not text:
                    continue
                words.append({'text': text, 'start': round(w.start, 3), 'end': round(w.end, 3), 'probability': round(w.probability, 3)})
        print(json.dumps({
            'file': f,
            'language': info.language,
            'durationSec': round(info.duration, 3),
            'words': words,
            'loadSec': round(load_sec, 3),
            'transcribeSec': round(time.time() - t1, 3),
            'cpuSec': round(cpu() - c1, 3),
        }), flush=True)


if __name__ == '__main__':
    main()
