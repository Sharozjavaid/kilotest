# Kilo contracts

What every part of Kilo must agree on. `PLAN.md` says what is being built and why; this file says how the parts fit. The types live in `packages/edl/src`; where this file and those types disagree, the types win.

## 1. Who owns what

Each directory is one independent npm project with its own `node_modules`. There is no workspace hoisting. Projects depend on the contracts with `"@kilo/edl": "file:../packages/edl"` (or `file:../edl` from inside `packages/`).

| Directory | Package | Owns |
|---|---|---|
| `packages/edl` | `@kilo/edl` | Schemas, settings and presets, template catalog, timeline helpers, API bodies, pipeline interfaces. **Read-only for everyone but the lead.** |
| `packages/analyze` | `@kilo/analyze` | Ingest, concat proxy, transcription providers, silence detection, the edit decider (Claude and heuristic), cut snapping, B-roll description and placement, graphic selection, hook variants, stock search. Exports `analyze: AnalyzeApi`. |
| `packages/render` | `@kilo/render` | EDL to MP4 with ffmpeg: cuts, zooms, transitions, B-roll and Ken Burns, graphic compositing, captions, loudness. Exports `render: RenderApi`. |
| `templates` | `@kilo/templates` | The five motion graphic templates and their renderer. Exports `templates: TemplatesApi`. |
| `server` | `@kilo/server` | HTTP API, database migrations, storage drivers, auth, job queue and worker, push notifications, goal reminders, the `kilo` command-line tool. |
| `app` | `kilo` | The Expo app: every screen, the API client, uploads, the recorder. |
| `fixtures` | — | Synthetic test recordings (`node fixtures/generate.mjs`). Output in `fixtures/out/` is not committed. |

If you need a change to `@kilo/edl`, do not edit it. Work around it locally and say exactly what you need in your final report.

## 2. Conventions

- Node 22, TypeScript strict, ES modules (`"type": "module"`), `npm` (not pnpm or yarn).
- Server-side projects run TypeScript with `tsx`, test with `vitest`, and expose `npm test` and `npm run typecheck`. Both must pass before you report done.
- Times are seconds as floats. Ids are opaque strings (the server uses UUIDs).
- Every external service sits behind a provider interface chosen by environment variable, with a provider that works offline. Nothing may require a network key to run its tests.
- Never log or commit secrets. Read keys only from the environment.
- ffmpeg and ffprobe are called as child processes (`execFile`, argument arrays, never a shell string).
- Do not run `git commit`, `git push` or `git checkout`. The lead commits.
- Do not create files outside your own directory, except scratch files under your own `.work/` folders.

## 3. The edit decision list

`Edl` in `packages/edl/src/edl.ts` is the single document every feature reads or writes. The rules that matter:

- Segments partition every clip completely. Array order is natural order. The finished video plays kept segments in that order unless a variant's `segmentOrder` says otherwise.
- A decider only ever marks kept segments with reason `speech`. The user toggles `keep`; `reason` is left alone and `userOverride` becomes true. Replanning never changes `keep`.
- Overlays are anchored to a segment (`anchorSegmentId` + `offsetSec`), never to absolute time. `resolveTimeline(edl, variantId)` turns the EDL into output-timeline positions. Use it; do not re-derive.
- Graphic overlay `props` must satisfy `TemplatePropsSchemas[template]`.
- `validateEdl(edl, clips)` must return no issues for anything a decider emits or the server stores.

## 4. Pipeline

`packages/edl/src/pipeline.ts` has the exact function signatures and media specs.

```
upload ──► ingestClip (per clip) ──► buildConcatProxy
                  │
                  ├─► transcribeClip ─┐
                  ├─► detectSilence ──┤
ingestBroll ──────┴───────────────────┴─► decideEdit ──► EDL (revision 0) ──► review
                                                                               │
                                              renderVideo ◄── save / export ◄──┘
                                                   └─ calls templates.renderGraphic per graphic overlay
```

### Providers and their environment variables

| Concern | Variable | Values | Default |
|---|---|---|---|
| Transcription | `KILO_TRANSCRIBER` | `deepgram`, `openai`, `fixture` | `deepgram` if `DEEPGRAM_API_KEY` is set, else `openai` if `OPENAI_API_KEY` is set, else `fixture` |
| Edit decisions | `KILO_DECIDER` | `claude`, `heuristic` | `claude` if `ANTHROPIC_API_KEY` is set, else `heuristic` |
| Claude model | `KILO_CLAUDE_MODEL` | a model id | `claude-fable-5-2` |
| B-roll description | follows the decider | Claude vision, or file name and probe data | |
| Stock B-roll | `PEXELS_API_KEY` | | none: `suggestStockBroll` returns `[]` |

`openai` means any endpoint compatible with the OpenAI transcription API (`OPENAI_BASE_URL` overrides the host), asked for word timestamps.

### The fixture transcriber

Test recordings carry their own transcript so the whole pipeline runs with no speech-to-text service.

- `fixtures/generate.mjs` writes each clip's transcript to the MP4 `comment` tag as `kilo-words:<base64 JSON>` and to a `.words.json` file beside the clip. The JSON is a `Transcript` whose `clipId` is a placeholder.
- `ingestClip` reads the `comment` tag with ffprobe. When it starts with `kilo-words:`, it writes the decoded JSON to `<audioPath without .wav>.words.json`.
- The `fixture` transcriber reads that sidecar, replaces `clipId` with the real one, and returns it. With no sidecar it returns a transcript with no words.

`fixtures/out/<id>/manifest.json` holds the ground truth: for each clip, `units[]` with `start`, `end`, `keep` and `reason`. Use it to score a decider.

## 5. HTTP API

Base path `/v1`. JSON in and out. Bodies are the zod schemas in `packages/edl/src/api.ts`; the server validates requests with them and the app parses responses with them. Errors are `ApiError` with the right status code.

| Method and path | Request | Response | Notes |
|---|---|---|---|
| `GET /v1/health` | | `{ ok: true }` | No auth. |
| `GET /v1/home` | | `HomeResponse` | |
| `POST /v1/batches` | `CreateBatchRequest` | `CreateBatchResponse` | Creates the batch, videos, clips and B-roll rows and an upload target for each file. |
| `GET /v1/batches/:id` | | `BatchDetail` | |
| `POST /v1/uploads/complete` | `CompleteUploadsRequest` | `CompleteUploadsResponse` | A video is queued once every clip and B-roll file it was created with is in. |
| `GET /v1/videos` | query `status`, `batchId` | `ListVideosResponse` | Newest first. |
| `GET /v1/videos/:id` | | `VideoDetail` | |
| `DELETE /v1/videos/:id` | | 204 | |
| `POST /v1/videos/:id/retry` | | `VideoSummary` | Only from `failed`. |
| `PUT /v1/videos/:id/edl` | `SaveEdlRequest` | `SaveEdlResponse` | 409 `revision_conflict` when `baseRevision` is stale. Stores `revision + 1`. A video that was `done` returns to `ready_for_review`. |
| `POST /v1/videos/:id/broll` | `AddBrollRequest` | `AddBrollResponse` | Files added after analysis are ingested on `uploads/complete`; placement waits for a replan. |
| `DELETE /v1/videos/:id/broll/:assetId` | | 204 | Also removes overlays that use it. |
| `POST /v1/videos/:id/replan` | `ReplanRequest` | `VideoSummary` | Status goes to `analyzing`, then back to `ready_for_review`. |
| `POST /v1/videos/:id/renders` | `CreateRenderRequest` | `CreateRenderResponse` | `final` sets the video to `rendering`, then `done` when every final render finishes. `preview` does not change video status. |
| `GET /v1/renders/:id` | | `RenderView` | |
| `POST /v1/videos/:id/posted` | `MarkPostedRequest` | `VideoSummary` | Counts toward the weekly goal. |
| `GET /v1/goal` / `PUT /v1/goal` | `UpdateGoalRequest` | `GoalView` | |
| `GET /v1/styles` | | `ListStylesResponse` | |
| `POST /v1/styles`, `PUT /v1/styles/:id` | `SaveStyleRequest` | `Style` | |
| `DELETE /v1/styles/:id` | | 204 | |
| `POST /v1/devices` | `RegisterDeviceRequest` | 204 | |

Local storage driver only: `PUT /v1/local/upload/:token` (raw bytes) and `GET /v1/local/file/:token` (supports `Range`). These are the URLs the driver hands out as upload targets and signed downloads.

### Video status

```
uploading ─► queued ─► analyzing ─► ready_for_review ─► rendering ─► done
                          ▲                │  ▲                       │
                          └──── replan ────┘  └────── edl saved ──────┘
any state ─► failed ─► (retry) ─► queued
```

Rules the server enforces, which the app must expect:

- Creating something answers 201.
- The EDL can be saved only while the video is `ready_for_review` or `done`; otherwise 409 `invalid_state`.
- A replan stores its result as revision + 1, so a client holding the older revision gets 409 on its next save and must refetch.
- A failed final render sets the video to `failed`; retrying re-runs analysis (finished steps are skipped) and lands on `ready_for_review`. A failed preview render changes nothing on the video.
- Marking posted needs a finished final render. A video counts once per week toward the goal whatever the platform.
- B-roll cannot be added to a `failed` video or removed while `analyzing` or `rendering`.
- `VideoSummary.progress` is 0..1 while `queued` or `analyzing` and null otherwise. `clipCount` is known from creation.
- A B-roll asset that is not yet `ready` has null width, height and duration and an empty description.

### Auth

`Authorization: Bearer <token>`.

- `KILO_AUTH=supabase`: the token is a Supabase access token, verified with `SUPABASE_JWT_SECRET`. The user id is the `sub` claim.
- `KILO_AUTH=dev`: the token is `dev:<user id>`. For local runs and tests only; the server refuses to start in this mode when `NODE_ENV=production`.

### Storage

One bucket (`KILO_BUCKET`, default `kilo`). `KILO_STORAGE=local` keeps files under `KILO_STORAGE_DIR`; `KILO_STORAGE=supabase` uses Supabase Storage with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` and hands the app `tus` upload targets.

```
users/<userId>/videos/<videoId>/clips/<clipId>/source.<ext>
users/<userId>/videos/<videoId>/clips/<clipId>/normalized.mp4
users/<userId>/videos/<videoId>/clips/<clipId>/thumb.jpg
users/<userId>/videos/<videoId>/proxy.mp4
users/<userId>/videos/<videoId>/broll/<assetId>/source.<ext>
users/<userId>/videos/<videoId>/broll/<assetId>/normalized.<ext>
users/<userId>/videos/<videoId>/broll/<assetId>/thumb.jpg
users/<userId>/videos/<videoId>/renders/<renderId>.mp4
```

URLs in API responses are signed and expire; the app refetches the video rather than caching them.

### Server environment

`DATABASE_URL`, `PORT` (default 8787), `KILO_PUBLIC_URL`, `KILO_AUTH`, `KILO_STORAGE`, `KILO_STORAGE_DIR`, `KILO_BUCKET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET`, `EXPO_ACCESS_TOKEN`, plus the provider variables in section 4.

Tuning, all optional: `KILO_PIPELINE` (`real` or `fake`), `KILO_PUSH` (`expo` or `log`), `KILO_WORK_DIR`, `KILO_ANALYZE_CONCURRENCY`, `KILO_RENDER_CONCURRENCY`, `KILO_JOB_RETRY_LIMIT`, `KILO_LOCAL_SIGNING_SECRET`, `KILO_URL_TTL_SEC`. `server/.env.example` is the full list.

### App environment

`EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`, and `EXPO_PUBLIC_MOCK=1` to run every screen against an in-memory mock of this API with no server.

## 6. Design

The app is named **kilo**, with the line "AI video editor". Light, calm, glassy, one blue accent. The mock-up is the reference for layout: https://claude.ai/artifact/8rk4supczNVodjAtLtgfvw

| Token | Value |
|---|---|
| `ground` | `#F5F8FC` |
| `skyTint` | `#D9E8FF`, a vertical gradient from the top of the screen fading into `ground` at about 36% |
| `surface` | `rgba(255,255,255,0.8)`, 1px border `rgba(12,24,48,0.08)`, shadow `0 8px 24px rgba(31,94,255,0.08)`, radius 20 |
| `ink` | `#0B1220` |
| `muted` | `#566074` |
| `accent` | `#1F5EFF` |
| `accentGloss` | vertical gradient `#2A66FF` to `#1A52E8`, shadow `0 8px 20px rgba(31,94,255,0.28)`; primary buttons, white text |
| `track` | `#D5DDEA` (empty progress, thumbnail placeholders) |
| `hairline` | `rgba(12,24,48,0.08)` |
| `outline` | `rgba(12,24,48,0.14)` (secondary pill buttons on white) |
| `cut` | `#B4441E` (cut-reason labels, outline of cut segments, destructive text) |
| `record` | `#F0442E` |
| `cameraScrim` | `#2B3038` behind white glass panels at 90% opacity |
| Type | Inter. Headings 600 to 700 with letter-spacing about -0.02em. Body 15, secondary 13, label 12 |
| Wordmark | lowercase `kilo`, weight 700, letter-spacing -1.2 at 28px |
| Controls | Pill buttons (radius = half height), primary 56 high, secondary 52, minimum touch target 44 |
| Kept vs cut | Kept: solid `accent`. Cut: white with a `cut` outline, text struck through in `muted`. They differ in lightness, not only hue. |

No emoji. Icons are simple 2px-stroke line icons. Text contrast at least 4.5:1.
