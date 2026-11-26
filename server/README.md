# @kilo/server

The Kilo HTTP API, the pipeline worker, database migrations, storage drivers,
auth, push notifications, goal reminders and the `kilo` command-line tool. One
codebase, three ways to run it:

| Command | Runs |
|---|---|
| `npm run api` | HTTP API only (`/v1/...`, port `PORT`, default 8787) |
| `npm run worker` | pg-boss workers: `video.analyze`, `video.replan`, `broll.ingest`, `render.run`, and the hourly `goal.reminders` |
| `npm run dev` | Both in one process, migrating on start |
| `npm run migrate` | Applies `migrations/*.sql` |
| `npm run kilo -- edit <clips...> --out out.mp4` | The whole pipeline locally, no database or HTTP |

## Running locally

```sh
npm install
eval "export $(bash scripts/dev-db.sh)"   # throwaway Postgres 16 on port 54329, prints DATABASE_URL
KILO_PIPELINE=fake npm run dev            # fake pipeline; drop KILO_PIPELINE once the real packages are installed
curl localhost:8787/v1/health
```

Defaults are all offline: `npm run dev` sets `KILO_AUTH=dev` (token `dev:<user uuid>`);
`api` and `worker` need `KILO_AUTH` set explicitly, with no default. `KILO_STORAGE=local`
(files under `KILO_STORAGE_DIR`, default `.work/storage`, served by the signed
`/v1/local/upload/:token` and `/v1/local/file/:token` routes, with `Range`), and
push notifications written to the log when a user has no devices. Every variable is
listed in `.env.example`.

The pipeline is injected (`src/pipeline`): `KILO_PIPELINE=real` (the default)
dynamically imports `@kilo/analyze`, `@kilo/render` and `@kilo/templates`;
`KILO_PIPELINE=fake` uses `src/pipeline/fake.ts`, which builds EDLs from the
fixtures' ground truth and renders tiny real MP4s. Tests always use the fakes.

CLI example on the synthetic fixtures (`node ../fixtures/generate.mjs` first):

```sh
npm run kilo -- edit ../fixtures/out/routine/clip1.mp4 --out .work/out/routine.mp4 \
  --broll ../fixtures/out/routine/broll/shelf.mp4 --variants 2 --quality preview
```

Recorder-style input, as the app's recorder sends it: each `--take <line>:<take>:<file>`
is one take of a script line (both counted from 1), so a line can have several takes and
the decider keeps the last good one. Browser recordings (WebM with no duration) work too.

```sh
npm run kilo -- edit --script script.txt --out .work/out/rec.mp4 \
  --take 1:1:take-a.webm --take 2:1:take-b.webm --take 2:2:take-c.webm --take 3:1:take-d.webm
```

## Tests

`npm test` starts the throwaway cluster with `scripts/dev-db.sh` if it is not
running, builds a migrated template database for the run, and gives each test
file its own database cloned from it. Tests use real Postgres, real local storage,
the real pg-boss queue and worker, and the fake pipeline. `KILO_TEST_VERBOSE=1`
prints logged errors. `npm run typecheck` checks `src` and `test`.

`npm run test:real` is the acceptance run (several minutes; not part of `npm test`).
For each fixture in `fixtures/out` (`routine`, `unboxing`, `mistakes`) it goes
through HTTP, the queue and the worker with the real `@kilo/analyze`,
`@kilo/render` and `@kilo/templates`: creates the batch with the fixture's mode and
B-roll, graphics, captions and three hooks on, uploads clips and B-roll, waits for
review while checking `progress`, scores the EDL against `manifest.json` (no word
of a kept unit clipped, every cut unit cut), restores one cut segment and saves,
replans, renders a preview and a final of every variant, downloads them and checks
them with ffprobe (1080x1920, the EDL's rate, duration within a frame of
`resolveTimeline`, about -14 LUFS). Every frame of every final is traced back to
the fixture unit it shows: no frame may show a cut line except the restored one,
and the orange cut band may only appear on that segment or on the short stretch of
pause the edit keeps between lines (the fixtures paint pauses orange too).
Results, timings and the renders go to `.work/acceptance/`.

## Uploads

Every file is declared with `sizeBytes` when its batch (or late B-roll) is created.
Files over `KILO_MAX_UPLOAD_BYTES` (default 2 GiB) are refused at creation. The
local driver's upload route stops a body that sends more than declared plus a
tolerance (1%, at least 64 KiB) with 413 `file_too_large`; `POST
/v1/uploads/complete` checks the stored size of every file against its declaration
(either driver), deletes a mismatching file and answers 400, so the app uploads it
again.

Clips must be MP4, MOV, M4V, WebM, MKV or 3GP; B-roll may also be JPEG, PNG, WebP or
HEIC. Anything else is refused at creation (400 `unsupported_file_type`), and the
pipeline checks the bytes as well. `uploads/complete` answers 200 with a result per id
(`not_found`, `not_uploaded`, `size_mismatch`) and starts every video whose files are
all in, whatever happened to the others; `POST /v1/uploads/targets` hands out fresh
targets for files not in yet. The local upload route refuses bytes for a file whose
video was deleted (or that is already in).

## Limits

Per user, configurable (see `.env.example`), answered with 429 and a code saying which:
videos uploading/queued/analysing at once (`too_many_active_videos`), renders waiting
(`too_many_renders`), replans of one video per hour (`too_many_replans`), batches per
day (`too_many_batches`). JSON bodies are capped (`KILO_MAX_BODY_BYTES`, 413
`body_too_large`). A render request for a cut whose render of the same revision is
still queued or running returns that render instead of making another. Jobs carry a
pg-boss priority of minus the number of jobs the same user already has waiting, so
users are served round-robin: one user's 50-video batch does not hold up another
user's single video.

## Saving edits

`PUT /v1/videos/:id/edl` takes from the client only `keep`, `userOverride`, `zoom` and
`transitionIn` of each segment, the overlays, the captions, and each variant's segment
order and overlays. Segment ids, clips and times must match the stored edit exactly;
`videoId`, `fps`, `settings`, `decidedBy`, segment reasons and text and variant labels
are copied from it. At most 4000 segments, 40 overlays, 5 variants and 10 overlays per
variant. `validateEdl` (including `duplicate_variant_segment`) and `checkOverlayRules`
must pass.

## Jobs, crashes and shutdown

The worker fetches jobs itself (not pg-boss's `work()`, which fails any handler that
runs longer than the job's expiry) and keeps each running job alive with a heartbeat.
Jobs expire after `KILO_JOB_EXPIRE_SEC` (90 s) without one, so a killed worker's job is
retried by another within about two minutes. On SIGTERM the worker takes no new jobs,
gives running ones `KILO_STOP_GRACE_MS` to finish (the pipeline kills its ffmpeg
children itself), then cancels what still runs and queues it again to start in a few
seconds, without spending a retry. On start, and every five minutes, videos left
`queued`/`analyzing` and renders left `queued`/`rendering` with no live job are queued
again (three times at most, then failed). Every storage write first checks that the
video still exists; a job whose video was deleted stops and removes what it wrote. An
hourly sweep removes storage prefixes with no video once their newest file is older
than `KILO_SWEEP_GRACE_SEC` (6 h).

A pipeline error's own message reaches the user ("This file type is not supported",
the timeout advice). A video in which no speech was heard keeps the notice from
`decideEditWithNotices()` (`VideoSummary.notice`).

## Production checks

At start the server logs which transcriber and decider are active (`describeProviders()`,
never keys). With `NODE_ENV=production` it refuses dev auth, local storage without a
chosen `KILO_LOCAL_SIGNING_SECRET`, and, unless `KILO_ALLOW_STAND_INS=1`, a worker whose
transcriber or decider is an offline stand-in.

## Auth

`KILO_AUTH=supabase` accepts both kinds of Supabase access token:

- HS256 tokens signed with the project's legacy JWT secret, when
  `SUPABASE_JWT_SECRET` is set;
- tokens signed with the project's asymmetric signing keys (ES256, RS256, EdDSA),
  verified against `<SUPABASE_URL>/auth/v1/.well-known/jwks.json`, when
  `SUPABASE_URL` is set. The key set is cached for 10 minutes and fetched again
  when a token names an unknown `kid` (key rotation), at most every 30 seconds. The
  issuer must be `<SUPABASE_URL>/auth/v1` when the token carries one.

Either way the token must be unexpired, carry `aud: authenticated` (and the
`authenticated` role when it has one) and, when `SUPABASE_URL` is set, the issuer
`<SUPABASE_URL>/auth/v1`, on both the HS256 and JWKS paths; `sub` is the user id. The
JWKS fetch times out after 5 s; once a key set is cached a refresh runs in the
background and never holds requests. A token that cannot be checked because the key
set could not be fetched answers 503 `auth_unavailable` (the app retries), not 401
(which signs the user out).

Push tokens stay with the account that registered them: `POST /v1/devices` does not
move a token registered to someone else. The app calls `DELETE /v1/devices` on
sign-out, after which the next account to sign in on that phone can register it.

## Local storage links

The local driver signs upload and download links with `KILO_LOCAL_SIGNING_SECRET`.
When it is unset the secret is read from `<KILO_STORAGE_DIR>/.local-signing-secret`,
created on first start, so links survive restarts and the API and worker processes
agree.

## Deploying

- **Database**: Supabase Postgres. Set `DATABASE_URL` to the direct connection
  (or session pooler); pg-boss needs `LISTEN`-free polling only, but long
  transactions and advisory locks rule out the transaction pooler for the worker.
  Run `npm run migrate` on each release. `002_rls.sql` and `005_lockdown.sql` apply
  only where the `auth` schema exists, so they run on Supabase and are skipped on plain
  Postgres. `005_lockdown.sql` removes every policy and revokes all table, sequence and
  function privileges in `public` (and pg-boss's schema) from `anon` and
  `authenticated`, now and through default privileges for tables created later, and
  leaves row-level security on with no policies: the app uses Supabase only to sign in,
  and no table is reachable through Supabase's REST API. The server connects as the
  table owner; it enforces ownership in every query and does not trust stored rows to
  name another user's files (signed URLs and job inputs must sit under the row's own
  `users/<user>/videos/<video>/` prefix). Run migrations as the role that owns the
  tables (normally `postgres`), so the default-privilege change covers future tables.
- **Storage**: `KILO_STORAGE=supabase`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  and a private bucket named `KILO_BUCKET` (default `kilo`). The app gets `tus`
  targets carrying a signed upload token (`x-signature`), never the service key.
- **Push**: Expo push API; `EXPO_ACCESS_TOKEN` only if the Expo project enforces it.
- **Auth**: see above; set `SUPABASE_URL` for projects on signing keys.
- **Containers**: one image, two services. Scale workers horizontally; keep
  `KILO_RENDER_CONCURRENCY` at 1 per CPU-limited container. `KILO_WORK_DIR` should
  be local scratch disk; a job that fails for good removes its directory there.

### Docker

`server/Dockerfile` builds from the repository root, so the `file:` packages
(`packages/edl`, `packages/analyze`, `packages/render`, `templates`) are in the
context and keep their relative layout:

```sh
docker build -f server/Dockerfile -t kilo-server .
docker run --env-file server/.env kilo-server migrate
docker run --env-file server/.env -p 8787:8787 kilo-server api
docker run --env-file server/.env kilo-server worker
```

The image is Node 22 on Debian bookworm with ffmpeg, Inter (`fonts-inter`, for
burned-in captions; the templates bundle their own copy) and a Chromium headless
shell installed by Playwright with its system libraries under
`/opt/pw-browsers`, where `@kilo/templates` finds it. Each project is installed
with `npm ci` (dev dependencies included: the services run TypeScript with `tsx`,
and `@kilo/edl` is built with `tsup` inside the image because `dist/` is not
committed). `tini` is PID 1; `docker-entrypoint.sh` maps `api`, `worker`, `dev`
and `migrate` to the scripts. `server/Dockerfile.dockerignore` keeps
`node_modules`, `.work`, the app and fixtures out of the context (BuildKit reads it
because it sits next to the Dockerfile). The template cache
(`KILO_TEMPLATES_CACHE_DIR=/var/cache/kilo-templates`) is pruned by age and size
(see `templates/README.md`); mount a volume there to keep rendered graphics
across restarts.

**The image has not been built or run**: it was written on a machine without a
Docker daemon. Expect to fix small things on the first build (the Playwright
version pin, Debian package names) and check that a worker renders a graphic
before deploying.

Not yet exercised against real services: the Supabase storage and auth drivers
(HS256 and JWKS) and the Expo provider are tested only against mocked HTTP and
locally signed tokens; the Docker image is unbuilt.
