#!/usr/bin/env python3
"""Acoustic check for Kilo's `whisper` transcriber (packages/analyze/src/ctc.ts): a small CTC
character model (wav2vec2-base-960h, ONNX, fp32) run on the CPU with onnxruntime. It prints, per
input WAV, the model's per-frame log-probabilities over its 32 characters, so the Node side can
read what was acoustically said without Whisper's language model:

  {"file": ..., "frameSec": 0.02, "vocab": [...], "blank": 0, "frames": T,
   "logprobs": <base64 of T x V float16, row-major>, "loadSec": ..., "cpuSec": ...}

Errors are printed (stdout and stderr) as {"error": <code>, "message": <text>}, exit status 2.
Nothing touches the network unless --allow-download is given.

Usage:
  kilo_ctc.py --cache-dir DIR [--threads 2] [--allow-download] FILE...
  kilo_ctc.py --cache-dir DIR --download-only
"""
import argparse
import base64
import json
import os
import resource
import sys
import time

# Xenova's ONNX export of facebook/wav2vec2-base-960h (Apache 2.0): a character CTC model
# fine-tuned on LibriSpeech's 960 h of training speech. Pinned so an upstream change cannot move
# the cuts silently. The int8 file in the same repo is not used: its output is garbled.
REPO = 'Xenova/wav2vec2-base-960h'
REV = 'a19f851b3d42865797e410752b4c570c871e4825'
FILES = ['vocab.json', 'onnx/model.onnx']

SR = 16000
HOP = 320  # samples per output frame (20 ms)
# Windows of 20 s with 2 s of context either side: self-attention cost grows with the square of
# the length, and a 70 s clip at once needs most of a gigabyte.
WIN = 20 * SR
CTX = 2 * SR


def fail(code: str, message: str) -> None:
    line = json.dumps({'error': code, 'message': message})
    print(line, flush=True)
    print(line, file=sys.stderr, flush=True)
    sys.exit(2)


def resolve(cache_dir: str, allow_download: bool) -> str:
    try:
        from huggingface_hub import snapshot_download
    except ImportError as e:  # pragma: no cover
        fail('missing_python_package', f'huggingface_hub is not installed for {sys.executable}: {e}')
    try:
        return snapshot_download(REPO, revision=REV, cache_dir=cache_dir, allow_patterns=FILES, local_files_only=not allow_download)
    except Exception as e:
        if allow_download:
            fail('model_download_failed', f'Could not download {REPO}: {e}')
        fail('model_missing', f'CTC model {REPO} is not in {cache_dir}: {type(e).__name__}')
    return ''


def load_wav(path: str):
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
    if rate != SR:
        t = np.arange(0, len(x) / rate, 1 / SR)
        x = np.interp(t, np.arange(len(x)) / rate, x).astype(np.float32)
    return x


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache-dir', required=True)
    ap.add_argument('--threads', type=int, default=2)
    ap.add_argument('--allow-download', action='store_true')
    ap.add_argument('--download-only', action='store_true')
    ap.add_argument('files', nargs='*')
    a = ap.parse_args()

    t0 = time.time()
    path = resolve(a.cache_dir, a.allow_download or a.download_only)
    if a.download_only:
        print(json.dumps({'model': REPO, 'path': path}), flush=True)
        return
    try:
        import numpy as np
        import onnxruntime as ort
    except ImportError as e:
        fail('missing_python_package', f'onnxruntime is not installed for {sys.executable}: {e}')
    with open(os.path.join(path, 'vocab.json')) as f:
        ids = json.load(f)
    vocab = [''] * len(ids)
    for k, v in ids.items():
        vocab[v] = k
    so = ort.SessionOptions()
    so.intra_op_num_threads = max(1, a.threads)
    so.inter_op_num_threads = 1
    sess = ort.InferenceSession(os.path.join(path, 'onnx', 'model.onnx'), so, providers=['CPUExecutionProvider'])
    name = sess.get_inputs()[0].name
    load_sec = time.time() - t0

    def cpu() -> float:
        r = resource.getrusage(resource.RUSAGE_SELF)
        return r.ru_utime + r.ru_stime

    for f in a.files:
        c1 = cpu()
        t1 = time.time()
        x = load_wav(f)
        total = max(1, (len(x) - 400) // HOP + 1) if len(x) >= 400 else 0
        out = np.zeros((total, len(vocab)), dtype=np.float32)
        s = 0
        while s < len(x) and total:
            a0 = max(0, s - CTX)
            b0 = min(len(x), s + WIN + CTX)
            seg = x[a0:b0]
            if len(seg) < 400:
                break
            seg = (seg - seg.mean()) / np.sqrt(seg.var() + 1e-7)
            lg = sess.run(None, {name: seg[None, :].astype(np.float32)})[0][0]
            lg = lg - lg.max(axis=1, keepdims=True)
            lp = lg - np.log(np.exp(lg).sum(axis=1, keepdims=True))
            f0 = a0 // HOP  # a0 is a multiple of HOP
            lo, hi = s // HOP, min(total, (s + WIN) // HOP if s + WIN < len(x) else total)
            out[lo:hi] = lp[lo - f0:hi - f0]
            s += WIN
        print(json.dumps({
            'file': f,
            'frameSec': HOP / SR,
            'vocab': vocab,
            'blank': ids.get('<pad>', 0),
            'frames': int(total),
            'logprobs': base64.b64encode(out.astype('<f2').tobytes()).decode('ascii'),
            'loadSec': round(load_sec, 3),
            'transcribeSec': round(time.time() - t1, 3),
            'cpuSec': round(cpu() - c1, 3),
        }), flush=True)


if __name__ == '__main__':
    main()
