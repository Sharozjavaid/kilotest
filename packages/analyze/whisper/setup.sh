#!/bin/sh
# Sets up the local `whisper` transcriber: a Python virtual environment with faster-whisper and
# the model, both in gitignored folders under packages/analyze/.work (or where the variables say).
#
#   npm run whisper:setup                                  # base.en (default, 145 MB) into .work/whisper-models
#   KILO_WHISPER_MODEL=small.en npm run whisper:setup        # 485 MB
#   KILO_WHISPER_MODEL=large-v3-turbo npm run whisper:setup  # 815 MB, int8, multilingual
#
# base.en is the default: on the real-speech recordings (fixtures/real/README.md) it keeps the
# right take more often than small.en or large-v3-turbo, at about 0.35 s of CPU per second of
# audio on two threads (second look included); small.en takes about 0.45 s and large-v3-turbo
# about 2.5 s, over a worker's budget of about 1 s. Pinned revisions are in kilo_whisper.py
# (PINNED); any other name is a Hugging Face repo id or a local folder.
#
# Then run with KILO_TRANSCRIBER=whisper. Nothing else in Kilo needs Python.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
pkg=$(cd "$here/.." && pwd)
venv=${KILO_WHISPER_VENV:-$pkg/.work/whisper-venv}
cache=${KILO_WHISPER_CACHE_DIR:-$pkg/.work/whisper-models}
model=${KILO_WHISPER_MODEL:-base.en}
python=${PYTHON:-python3}

if [ ! -x "$venv/bin/python" ]; then
  echo "Creating $venv"
  "$python" -m venv "$venv"
fi
"$venv/bin/python" -m pip install --quiet --upgrade pip
"$venv/bin/python" -m pip install --quiet -r "$here/requirements.txt"
mkdir -p "$cache"
echo "Downloading Whisper $model to $cache (from Hugging Face)"
"$venv/bin/python" -I "$here/kilo_whisper.py" --model "$model" --cache-dir "$cache" --download-only
echo "Done. KILO_TRANSCRIBER=whisper now uses $venv/bin/python and $cache."
if [ "$venv" != "$pkg/.work/whisper-venv" ]; then echo "Set KILO_WHISPER_PYTHON=$venv/bin/python"; fi
if [ "$cache" != "$pkg/.work/whisper-models" ]; then echo "Set KILO_WHISPER_CACHE_DIR=$cache"; fi
