#!/usr/bin/env python3
"""Downloads the real speech the fixtures/real recordings are assembled from.

Run with the data venv (see README.md):

    fixtures/real/.work/venv/bin/python -I fixtures/real/fetch.py

Writes, under fixtures/real/.work/cache/ (gitignored, never committed):

  librispeech/<utterance id>.flac   LibriSpeech dev-clean audio, as published
  librispeech/<utterance id>.json   its transcript and Montreal Forced Aligner word times
  disfluency/<n>.flac + .json       DisfluencySpeech test split, for the filler-retention check

Only the parquet row groups the specs use are read (HTTP range requests), so the
download stays near 140 MB for LibriSpeech and 71 MB for DisfluencySpeech.
Both datasets are pinned to a revision so the recordings rebuild identically.
"""
import io
import json
import os
import sys

import pyarrow.parquet as pq
from huggingface_hub import HfFileSystem

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, '.work', 'cache')

# LibriSpeech (CC BY 4.0) with MFA alignments, shared by Loren Lugosch, packaged by gilkeyio.
LIBRI_REPO = 'datasets/gilkeyio/librispeech-alignments'
LIBRI_REV = '0daa1eb43dda38ee6ce752e785555380e5628f5c'
LIBRI_FILE = 'data/dev_clean-00000-of-00001.parquet'
# Row groups of 100 rows each. These hold the same-speaker near-repeats the specs use
# (speakers 174, 777, 2078, 3081) and enough lines for every other speaker.
LIBRI_ROW_GROUPS = [3, 6, 7, 14, 15, 16, 20, 21, 25, 26]

# DisfluencySpeech (Apache 2.0): one speaker re-enacting Switchboard calls, fillers included.
DISFL_REPO = 'datasets/amaai-lab/DisfluencySpeech'
DISFL_REV = 'b7da294fe3a70dd96df6640893f2a5dfc2c87638'
DISFL_FILE = 'data/test-00000-of-00001.parquet'


def fetch_libri(fs: HfFileSystem) -> int:
    out = os.path.join(CACHE, 'librispeech')
    os.makedirs(out, exist_ok=True)
    n = 0
    with fs.open(f'{LIBRI_REPO}@{LIBRI_REV}/{LIBRI_FILE}', 'rb', block_size=1 << 22) as f:
        pf = pq.ParquetFile(f)
        for g in LIBRI_ROW_GROUPS:
            for r in pf.read_row_group(g).to_pylist():
                uid = r['id']
                flac = os.path.join(out, f'{uid}.flac')
                if not os.path.exists(flac):
                    tmp = flac + '.part'
                    with open(tmp, 'wb') as w:
                        w.write(r['audio']['bytes'])
                    os.replace(tmp, flac)
                meta = {
                    'id': uid,
                    'speaker': uid.split('-')[0],
                    'chapter': uid.split('-')[1],
                    'sex': r['sex'],
                    'transcript': r['transcript'],
                    'words': [{'text': w['word'], 'start': w['start'], 'end': w['end']} for w in r['words']],
                    'source': f'LibriSpeech dev-clean {uid} (CC BY 4.0), MFA alignment via {LIBRI_REPO}@{LIBRI_REV[:8]}',
                }
                with open(os.path.join(out, f'{uid}.json'), 'w') as w:
                    json.dump(meta, w)
                n += 1
            print(f'librispeech row group {g}: done', flush=True)
    return n


def fetch_disfluency(fs: HfFileSystem) -> int:
    out = os.path.join(CACHE, 'disfluency')
    os.makedirs(out, exist_ok=True)
    n = 0
    with fs.open(f'{DISFL_REPO}@{DISFL_REV}/{DISFL_FILE}', 'rb', block_size=1 << 22) as f:
        pf = pq.ParquetFile(f)
        for g in range(pf.metadata.num_row_groups):
            for r in pf.read_row_group(g).to_pylist():
                name = f'{n:03d}'
                audio = r['audio']
                ext = os.path.splitext(audio.get('path') or 'x.wav')[1] or '.wav'
                with open(os.path.join(out, name + ext), 'wb') as w:
                    w.write(audio['bytes'])
                meta = {k: r[k] for k in ('transcript_annotated', 'transcript_a', 'transcript_b', 'transcript_c')}
                meta['audio'] = name + ext
                meta['source'] = f'DisfluencySpeech test {audio.get("path")} (Apache 2.0) via {DISFL_REPO}@{DISFL_REV[:8]}'
                with open(os.path.join(out, name + '.json'), 'w') as w:
                    json.dump(meta, w)
                n += 1
    return n


def main() -> None:
    which = sys.argv[1:] or ['librispeech', 'disfluency']
    fs = HfFileSystem()
    if 'librispeech' in which:
        print('librispeech utterances:', fetch_libri(fs))
    if 'disfluency' in which:
        print('disfluency utterances:', fetch_disfluency(fs))


if __name__ == '__main__':
    main()
