# Kilo API and worker: one image, two commands.
#
# Build from the repository root, so the file: packages next to the server are in the context:
#   docker build -f server/Dockerfile -t kilo-server .
# Run:
#   docker run --env-file server/.env -p 8787:8787 kilo-server api
#   docker run --env-file server/.env kilo-server worker
#   docker run --env-file server/.env kilo-server migrate
#
# NOT YET BUILT OR RUN: written on a machine without a Docker daemon. See server/README.md.

FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
    KILO_TEMPLATES_CACHE_DIR=/var/cache/kilo-templates \
    KILO_WORK_DIR=/var/tmp/kilo-jobs \
    KILO_FFMPEG_THREADS=2 \
    KILO_RENDER_THREADS=2

# ffmpeg/ffprobe for ingest and render (libass for captions, ProRes for graphics),
# Inter for burned-in captions (the templates bundle their own copy), tini as PID 1.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-inter fontconfig tini ca-certificates \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*

# Chromium headless shell for the Remotion templates, with its system libraries.
# @kilo/templates finds it under PLAYWRIGHT_BROWSERS_PATH (or set KILO_CHROMIUM_PATH).
RUN npx -y playwright@1.49.1 install --with-deps chromium-headless-shell \
 && rm -rf /root/.npm /var/lib/apt/lists/*

# Optional: the local, free `whisper` transcriber (KILO_TRANSCRIBER=whisper), an open Whisper model
# on the CPU through faster-whisper. Off by default, so the image needs no Python; build with
#   docker build -f server/Dockerfile --build-arg KILO_WITH_WHISPER=1 [--build-arg KILO_WHISPER_MODEL=small.en] .
# The model is downloaded from Hugging Face at build time, never at run time: base.en (the default,
# about 145 MB, about 0.35 s of CPU per second of audio on two threads), small.en (485 MB, 0.45 s) or
# large-v3-turbo (815 MB int8, about 2.5 s: over a worker's budget), each pinned in kilo_whisper.py.
# base.en keeps the right take most often on the real-speech recordings (fixtures/real/README.md).
# The CTC check against Whisper's words (KILO_WHISPER_ALIGN=ctc, the default) needs its model too:
# wav2vec2-base-960h, 378 MB, about 0.16 s of CPU per second of audio; --build-arg
# KILO_WHISPER_ALIGN=none leaves it out and turns the check off.
# NOT YET BUILT: these steps were run by hand outside Docker (packages/analyze/whisper/setup.sh), not here.
ARG KILO_WITH_WHISPER=0
ARG KILO_WHISPER_MODEL=base.en
ARG KILO_WHISPER_ALIGN=ctc
COPY packages/analyze/whisper/requirements.txt packages/analyze/whisper/kilo_whisper.py packages/analyze/whisper/kilo_ctc.py /opt/kilo-whisper/
RUN if [ "$KILO_WITH_WHISPER" = "1" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends python3 python3-venv \
      && rm -rf /var/lib/apt/lists/* \
      && python3 -m venv /opt/whisper-venv \
      && /opt/whisper-venv/bin/pip install --no-cache-dir -r /opt/kilo-whisper/requirements.txt \
      && /opt/whisper-venv/bin/python -I /opt/kilo-whisper/kilo_whisper.py --model "$KILO_WHISPER_MODEL" --cache-dir /opt/whisper-models --download-only \
      && if [ "$KILO_WHISPER_ALIGN" != "none" ]; then /opt/whisper-venv/bin/python -I /opt/kilo-whisper/kilo_ctc.py --cache-dir /opt/whisper-models --download-only; fi \
      && chmod -R a+rX /opt/whisper-models; \
    fi
ENV KILO_WHISPER_PYTHON=/opt/whisper-venv/bin/python \
    KILO_WHISPER_CACHE_DIR=/opt/whisper-models \
    KILO_WHISPER_MODEL=$KILO_WHISPER_MODEL \
    KILO_WHISPER_ALIGN=$KILO_WHISPER_ALIGN

# The projects keep the repository layout: every file: dependency is a relative symlink.
WORKDIR /app

# 1. Dependencies, one project at a time, so this layer is reused while only sources change.
COPY packages/edl/package.json packages/edl/package-lock.json packages/edl/
COPY packages/analyze/package.json packages/analyze/package-lock.json packages/analyze/
COPY packages/render/package.json packages/render/package-lock.json packages/render/
COPY templates/package.json templates/package-lock.json templates/
COPY server/package.json server/package-lock.json server/
# Dev dependencies are installed on purpose: the services run TypeScript with tsx, and @kilo/edl builds with tsup.
RUN cd packages/edl && npm ci --include=dev \
 && cd ../analyze && npm ci --include=dev \
 && cd ../render && npm ci --include=dev \
 && cd ../../templates && npm ci --include=dev \
 && cd ../server && npm ci --include=dev \
 && rm -rf /root/.npm

# 2. Sources. @kilo/edl is consumed as built output (dist/ is not committed).
COPY packages/edl packages/edl
RUN cd packages/edl && npm run build
COPY packages/analyze packages/analyze
COPY packages/render packages/render
COPY templates templates
COPY server server

RUN mkdir -p "$KILO_TEMPLATES_CACHE_DIR" "$KILO_WORK_DIR" \
 && chown -R node:node "$KILO_TEMPLATES_CACHE_DIR" "$KILO_WORK_DIR"

USER node
WORKDIR /app/server
EXPOSE 8787

# `api`, `worker`, `dev` (both, migrating on start) or `migrate`.
ENTRYPOINT ["/usr/bin/tini", "--", "/app/server/docker-entrypoint.sh"]
CMD ["api"]
