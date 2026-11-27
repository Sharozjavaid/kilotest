#!/usr/bin/env python3
"""Downloads the real speech the fixtures/real recordings are assembled from.

Run with the data venv (see README.md):

    fixtures/real/.work/venv/bin/python -I fixtures/real/fetch.py

Writes, under fixtures/real/.work/cache/ (gitignored, never committed):

  librispeech/<utterance id>.flac   LibriSpeech dev-clean audio, as published
  librispeech/<utterance id>.json   its transcript and Montreal Forced Aligner word times
  librispeech-test/<id>.flac + .json  the same from test-clean, for the final set (specs-final/)
  librispeech-test-other/<id>.flac + .json  the same from test-other, for the "other" set (specs-other/)
  librispeech-dev-other/<id>.flac + .json  the same from dev-other, for the devother set (specs-devother/)
  disfluency/<n>.flac + .json       DisfluencySpeech test split, for the filler-retention check

    fixtures/real/.work/venv/bin/python -I fixtures/real/fetch.py librispeech-test   # only the final set's audio
    fixtures/real/.work/venv/bin/python -I fixtures/real/fetch.py librispeech-test-other   # only the other set's audio
    fixtures/real/.work/venv/bin/python -I fixtures/real/fetch.py librispeech-dev-other   # only the devother set's audio

Only the parquet row groups the specs use are read (HTTP range requests), so the
download stays near 140 MB for LibriSpeech dev-clean, 115 MB for test-clean, 355 MB for
test-other (all of it), 320 MB for dev-other (all of it) and 71 MB for DisfluencySpeech.
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
# test-clean, for the final set: its 40 speakers are none of dev-clean's. Rows are spread over the
# row groups, so the first 8 (about 115 MB) give 30 speakers a chapter of 5 or more usable lines.
LIBRI_TEST_FILE = 'data/test_clean-00000-of-00001.parquet'
LIBRI_TEST_ROW_GROUPS = list(range(8))
# test-other, for the "other" set: the harder, noisier half of LibriSpeech, 33 speakers none of the
# other splits use. All 30 row groups (2938 rows, about 355 MB): every speaker has a usable chapter.
LIBRI_TEST_OTHER_FILE = 'data/test_other-00000-of-00001.parquet'
LIBRI_TEST_OTHER_ROW_GROUPS = list(range(30))
# dev-other, for the devother set: 33 more speakers none of the other splits use. All 29 row groups
# (2864 rows, about 320 MB).
LIBRI_DEV_OTHER_FILE = 'data/dev_other-00000-of-00001.parquet'
LIBRI_DEV_OTHER_ROW_GROUPS = list(range(29))

# DisfluencySpeech (Apache 2.0): one speaker re-enacting Switchboard calls, fillers included.
DISFL_REPO = 'datasets/amaai-lab/DisfluencySpeech'
DISFL_REV = 'b7da294fe3a70dd96df6640893f2a5dfc2c87638'
DISFL_FILE = 'data/test-00000-of-00001.parquet'


def fetch_libri(fs: HfFileSystem, folder: str = 'librispeech', file: str = LIBRI_FILE, groups=LIBRI_ROW_GROUPS, split: str = 'dev-clean') -> int:
    out = os.path.join(CACHE, folder)
    os.makedirs(out, exist_ok=True)
    n = 0
    with fs.open(f'{LIBRI_REPO}@{LIBRI_REV}/{file}', 'rb', block_size=1 << 22) as f:
        pf = pq.ParquetFile(f)
        for g in groups:
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
                    'source': f'LibriSpeech {split} {uid} (CC BY 4.0), MFA alignment via {LIBRI_REPO}@{LIBRI_REV[:8]}',
                }
                with open(os.path.join(out, f'{uid}.json'), 'w') as w:
                    json.dump(meta, w)
                n += 1
            print(f'librispeech {split} row group {g}: done', flush=True)
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
    if 'librispeech-test' in which:
        print('librispeech test-clean utterances:', fetch_libri(fs, 'librispeech-test', LIBRI_TEST_FILE, LIBRI_TEST_ROW_GROUPS, 'test-clean'))
    if 'librispeech-test-other' in which:
        print('librispeech test-other utterances:', fetch_libri(fs, 'librispeech-test-other', LIBRI_TEST_OTHER_FILE, LIBRI_TEST_OTHER_ROW_GROUPS, 'test-other'))
    if 'librispeech-dev-other' in which:
        print('librispeech dev-other utterances:', fetch_libri(fs, 'librispeech-dev-other', LIBRI_DEV_OTHER_FILE, LIBRI_DEV_OTHER_ROW_GROUPS, 'dev-other'))
    if 'disfluency' in which:
        print('disfluency utterances:', fetch_disfluency(fs))


if __name__ == '__main__':
    main()
