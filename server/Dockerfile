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
