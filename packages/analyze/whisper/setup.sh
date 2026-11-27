#!/bin/sh
# Sets up the local `whisper` transcriber: a Python virtual environment with faster-whisper and
# the model, both in gitignored folders under packages/analyze/.work (or where the variables say).
#
#   npm run whisper:setup                       # base.en into .work/whisper-models
#   KILO_WHISPER_MODEL=small.en npm run whisper:setup
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
