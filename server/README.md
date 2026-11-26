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

Defaults are all offline: `KILO_AUTH=dev` (token `dev:<user uuid>`), `KILO_STORAGE=local`
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

## Tests

`npm test` starts the throwaway cluster with `scripts/dev-db.sh` if it is not
running, builds a migrated template database for the run, and gives each test
file its own database cloned from it. Tests use real Postgres, real local storage,
the real pg-boss queue and worker, and the fake pipeline. `KILO_TEST_VERBOSE=1`
prints logged errors. `npm run typecheck` checks `src` and `test`.

## Deploying

- **Database**: Supabase Postgres. Set `DATABASE_URL` to the direct connection
  (or session pooler); pg-boss needs `LISTEN`-free polling only, but long
  transactions and advisory locks rule out the transaction pooler for the worker.
  Run `npm run migrate` on each release. `002_rls.sql` (row-level security keyed
  on `auth.uid()`) applies only where the `auth` schema exists, so it runs on
  Supabase and is skipped on plain Postgres. The server connects as the table
  owner and is not subject to RLS; it enforces ownership in every query.
- **Storage**: `KILO_STORAGE=supabase`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  and a private bucket named `KILO_BUCKET` (default `kilo`). The app gets `tus`
  targets carrying a signed upload token (`x-signature`), never the service key.
- **Auth**: `KILO_AUTH=supabase` with `SUPABASE_JWT_SECRET` (HS256 project secret).
- **Push**: Expo push API; `EXPO_ACCESS_TOKEN` only if the Expo project enforces it.
- **Containers**: one image, two services (`npm run api`, `npm run worker`). The
  worker image needs `ffmpeg`/`ffprobe` and Chromium (for the Remotion templates),
  plus the three pipeline packages installed next to the server. Scale workers
  horizontally; keep `KILO_RENDER_CONCURRENCY` at 1 per CPU-limited container.
  `KILO_WORK_DIR` should be local scratch disk.

Not yet exercised against real services: the Supabase storage and auth drivers
and the Expo provider are tested only against mocked HTTP and locally signed JWTs.
