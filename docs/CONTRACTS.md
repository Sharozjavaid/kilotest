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
| `fixtures` | — | Synthetic test recordings (`node fixtures/generate.mjs`), and in `fixtures/real/` recordings assembled from real read speech (LibriSpeech, see its README). Output in `fixtures/out/` and `fixtures/real/.work/` is not committed. |

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

`packages/edl/src/pipeline.ts` has the exact function signatures and media specs. `ingestClip` and `ingestBroll` write fixed file names, so every call needs a `workDir` of its own.

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
| Transcription | `KILO_TRANSCRIBER` | `deepgram`, `openai`, `whisper`, `fixture` | `deepgram` if `DEEPGRAM_API_KEY` is set, else `openai` if `OPENAI_API_KEY` is set, else `fixture`; `whisper` only when named |
| Edit decisions | `KILO_DECIDER` | `claude`, `heuristic` | `claude` if `ANTHROPIC_API_KEY` is set, else `heuristic` |
| Claude model | `KILO_CLAUDE_MODEL` | a model id | `claude-fable-5-2` |
| B-roll description | follows the decider | Claude vision, or file name and probe data | |
| Stock B-roll | `PEXELS_API_KEY` | | none: `suggestStockBroll` returns `[]` |

`openai` means any endpoint compatible with the OpenAI transcription API (`OPENAI_BASE_URL` overrides the host), asked for word timestamps.

`whisper` runs an open Whisper model on the worker's CPU (faster-whisper, CTranslate2 int8): no key, and no network once installed. `KILO_WHISPER_MODEL` picks it: `base.en` (default, 145 MB, about 0.35 s of CPU per second of audio on two threads), `small.en` (485 MB, about 0.45 s) or `large-v3-turbo` (815 MB, multilingual, about 2.5 s), each pinned to a revision, or a Hugging Face repo id or local folder. On Kilo's real-speech tests `base.en` keeps the right take most often: the larger models more often write a phrase said twice as one copy, which hides the retake. It needs Python with `packages/analyze/whisper/requirements.txt` and a downloaded model. `npm run whisper:setup` in `packages/analyze` puts both under `packages/analyze/.work/` (gitignored); the server image does the same with `--build-arg KILO_WITH_WHISPER=1` (and `KILO_WHISPER_MODEL`). Nothing else needs Python. A missing Python, package or model fails the clip with a message naming the fix, and the model is never downloaded during a job unless `KILO_WHISPER_ALLOW_DOWNLOAD=1`. Words Whisper wrote without hearing them are dropped (zero-length runs, words packed faster than speech, echoes, words laid over silence). A stretch of speech that holds far fewer words than it takes to say, or that opens mid-sentence after a long pause, is transcribed again on its own, and its words are used when they say clearly more. Word times are moved to the measured silences and leaned a little into each pause. Fillers are flagged by the shared lexicon. Whisper still drops about a third of "um" and "uh" even with Kilo's prompt, so some fillers stay in the edit.

`detectSilence` runs ffmpeg's silencedetect plus a pass against the local room tone, and settles every silence edge where the level is back at room tone, so a cut never starts inside a fading word.

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
| `GET /v1/home` | | `HomeResponse` | `activeBatches`: every batch with a video that is not `done` (uploading, editing, to review, exporting or failed), newest first; a batch leaves Home once all its videos are done or deleted. `readyToReview`: newest batch first, each batch's videos in the order they were created. `recent` holds the 50 latest videos that are exporting (`rendering`) or `done`, most recently updated first. |
| `POST /v1/batches` | `CreateBatchRequest` | `CreateBatchResponse` | Creates the batch, videos, clips and B-roll rows and an upload target for each file. 400 `unsupported_file_type` for a file extension outside the allowed list. Each video is stored with its own settings: `NewVideo.settings` laid over the batch's. `BatchSummary.settings` is the batch's defaults as created; a video's own settings are in its EDL (`edl.settings`). |
| `GET /v1/batches/:id` | | `BatchDetail` | |
| `POST /v1/uploads/complete` | `CompleteUploadsRequest` | `CompleteUploadsResponse` | Answers 200 with a result per id; one bad id never fails the others. A video is queued once every clip and B-roll file it was created with is in. |
| `POST /v1/uploads/targets` | `ReissueUploadsRequest` | `ReissueUploadsResponse` | Fresh upload targets for files not yet in, after a target expired. |
| `GET /v1/videos` | query `status`, `batchId`, `q`, `order`, `limit`, `after` | `ListVideosResponse` | `status`: one status or several, comma-separated. `q`: words in the title. `order`: `created` (default, newest first) or `batch` (newest batch first, each batch in its own order). `limit` 1..200 pages the list (without it, up to 500 rows); `after` takes the previous page's `nextCursor`, which is null on the last page. `total` counts every video matching the filters. 400 for an unknown status, order or cursor. |
| `GET /v1/videos/:id` | | `VideoDetail` | |
| `DELETE /v1/videos/:id` | | 204 | |
| `POST /v1/videos/:id/retry` | | `VideoSummary` | Only from `failed`. |
| `PUT /v1/videos/:id/edl` | `SaveEdlRequest` | `SaveEdlResponse` | 409 `revision_conflict` when `baseRevision` is stale. Stores `revision + 1`. A video that was `done` returns to `ready_for_review`. |
| `POST /v1/videos/:id/broll` | `AddBrollRequest` | `AddBrollResponse` | Files added after analysis are ingested on `uploads/complete`; placement waits for a replan. |
| `DELETE /v1/videos/:id/broll/:assetId` | | 204 | Also removes overlays that use it. |
| `POST /v1/videos/:id/replan` | `ReplanRequest` | `VideoSummary` | Status goes to `analyzing`, then back to `ready_for_review`. |
| `POST /v1/videos/:id/renders` | `CreateRenderRequest` | `CreateRenderResponse` | `final` sets the video to `rendering`, then `done` when every final render finishes. `preview` does not change video status. A request for a cut whose render of the same revision and quality is still queued or running gets that render back. |
| `GET /v1/renders/:id` | | `RenderView` | |
| `POST /v1/videos/:id/posted` | `MarkPostedRequest` | `VideoSummary` | Counts toward the weekly goal. |
| `GET /v1/goal` / `PUT /v1/goal` | `UpdateGoalRequest` | `GoalView` | |
| `GET /v1/styles` | | `ListStylesResponse` | |
| `POST /v1/styles`, `PUT /v1/styles/:id` | `SaveStyleRequest` | `Style` | |
| `DELETE /v1/styles/:id` | | 204 | |
| `POST /v1/devices` | `RegisterDeviceRequest` | 204 | A token registered to another account is not moved. |
| `DELETE /v1/devices` | `UnregisterDeviceRequest` | 204 | Called on sign-out. Only removes a token registered to the caller. |

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
- `sizeBytes` must be the file's exact size. A declared size over `KILO_MAX_UPLOAD_BYTES` (default 2 GiB) is refused at creation; a body larger than declared is stopped with 413 `file_too_large`; `uploads/complete` answers 400 and deletes the object when the stored size does not match.
- Overlays in a saved EDL must satisfy `checkOverlayRules` from `@kilo/edl`: on the base cut no two overlays overlap and no B-roll starts in the first two seconds (the hook stays on the speaker). Overlays that belong to a variant, such as its hook title, are not checked. A save that breaks this answers 400. Deciders and the app's overlay editor use the same function.
- A variant may hide overlays of the base cut with `hiddenOverlayIds`, for example B-roll that would cover the line it opens on. `resolveTimeline(edl, variantId)` leaves them out, so the review player, the renderer and the export all agree. Deciders must emit variants that pass `checkOverlayRules(edl, variantId)`; a save may change a variant's `hiddenOverlayIds`, and ids that name no base overlay, an id listed twice, or more than 40 ids answer 400. When a base overlay goes (a save removes it, its B-roll is deleted, a replan drops it) its id is dropped from every variant; a save that removes an overlay may still list it as hidden.
- `NewVideo.settings` holds settings for one video, laid over the batch's. The server stores the merged result per video; analysis, replans and the stored EDL use only the video's settings. The batch's settings (`BatchSummary.settings`) are the defaults the batch was created with and drive nothing on their own.
- A save may change only: each segment's `keep`, `userOverride`, `zoom` and `transitionIn`; the overlays; the captions; and each variant's `segmentOrder`, overlays and `hiddenOverlayIds`. Segment ids, clips and times must match the stored EDL exactly, and everything else (`videoId`, `fps`, `settings`, `decidedBy`, segment text and reasons, variant ids and labels) is copied from the stored EDL. Anything else answers 400.
- A saved EDL holds at most 4000 segments, 40 overlays, 5 variants and 10 overlays per variant, and a variant may list a segment only once.
- File types. Clips: `mp4`, `mov`, `m4v`, `webm`, `mkv`, `3gp`. B-roll: those, plus `jpg`, `jpeg`, `png`, `webp`, `heic`. Anything else answers 400 `unsupported_file_type`.
- JSON request bodies over `KILO_MAX_BODY_BYTES` (default 2 MiB) answer 413 `body_too_large`.
- Per-user limits answer 429: `too_many_active_videos` (`KILO_MAX_ACTIVE_VIDEOS`, default 150 uploading, queued or analysing), `too_many_renders` (`KILO_MAX_QUEUED_RENDERS`, default 300 queued or rendering, enough to export a full batch at once), `too_many_replans` (`KILO_MAX_REPLANS_PER_HOUR`, default 12 per video), `too_many_batches` (`KILO_MAX_BATCHES_PER_DAY`, default 40). Setting one to 0 turns it off.
- Jobs are queued so users take turns: a 30-video batch does not hold up another user's single video.
- `VideoSummary.notice` carries a short message when the video was analysed but something is worth telling the user, such as no speech being heard; null otherwise.
- A failed clip or render carries the pipeline's own user message (unsupported file, or took too long) rather than a generic one.
- Deleting a video stops its jobs and removes its files. Storage left with no matching video is swept after `KILO_SWEEP_GRACE_SEC` (default 6 hours).

### Auth

`Authorization: Bearer <token>`.

`KILO_AUTH` must be set; there is no default (`npm run dev` sets `dev`).

- `KILO_AUTH=supabase`: the token is a Supabase access token. Tokens signed with asymmetric keys are verified against the project's JWKS at `<SUPABASE_URL>/auth/v1/.well-known/jwks.json`; HS256 tokens are verified with `SUPABASE_JWT_SECRET` when it is set. Either variable is enough to start. The token must carry `aud: authenticated` and the project's issuer. The user id is the `sub` claim.
- `KILO_AUTH=dev`: the token is `dev:<user id>`. For local runs and tests only; the server refuses to start in this mode when `NODE_ENV=production`.
- A bad or expired token answers 401. When the server cannot check a token (the JWKS could not be fetched) it answers 503 `auth_unavailable`; the app signs out only on 401.

The app uses Supabase only to sign in. Every read and write goes through this API, which connects as the table owner. Migration `005_lockdown.sql` removes every privilege and policy the Supabase client roles (`anon`, `authenticated`) have on the tables, so the anon key the app ships cannot read or forge rows.

In production (`NODE_ENV=production`) the server also refuses to start with local storage and no chosen `KILO_LOCAL_SIGNING_SECRET`, or with a stand-in transcriber, decider or pipeline unless `KILO_ALLOW_STAND_INS=1`. It logs which providers are in use at startup, without keys.

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

Optional, with defaults. `server/.env.example` is the full list for the server.

| Area | Variables |
|---|---|
| API | `KILO_CORS_ORIGINS` (browser origins allowed, default any), `KILO_MAX_BODY_BYTES`, `KILO_MAX_UPLOAD_BYTES`, `KILO_URL_TTL_SEC`, `KILO_LOCAL_SIGNING_SECRET` |
| Per-user limits | `KILO_MAX_ACTIVE_VIDEOS`, `KILO_MAX_QUEUED_RENDERS`, `KILO_MAX_REPLANS_PER_HOUR`, `KILO_MAX_BATCHES_PER_DAY` |
| Worker | `KILO_PIPELINE` (`real` or `fake`), `KILO_PUSH` (`expo` or `log`), `KILO_WORK_DIR`, `KILO_ANALYZE_CONCURRENCY`, `KILO_RENDER_CONCURRENCY`, `KILO_JOB_RETRY_LIMIT`, `KILO_JOB_EXPIRE_SEC` (a job with no heartbeat for this long is retried, default 90), `KILO_STOP_GRACE_MS`, `KILO_SWEEP_GRACE_SEC`, `KILO_ALLOW_STAND_INS` |
| Analysis | `KILO_DEEPGRAM_MODEL`, `DEEPGRAM_BASE_URL`, `KILO_OPENAI_TRANSCRIBE_MODEL`, `KILO_OPENAI_MAX_UPLOAD_BYTES`; for `whisper`: `KILO_WHISPER_PYTHON`, `KILO_WHISPER_MODEL` (`base.en` default, `small.en`, `large-v3-turbo`, a repo id or a folder), `KILO_WHISPER_CACHE_DIR`, `KILO_WHISPER_THREADS` (default 2), `KILO_WHISPER_PROMPT` (empty: Kilo's prompt that keeps fillers; `none`: no prompt), `KILO_WHISPER_ALLOW_DOWNLOAD` |
| ffmpeg | `KILO_FFMPEG`, `KILO_FFPROBE` (binary paths), `KILO_FFMPEG_THREADS`, `KILO_RENDER_THREADS`, `KILO_RENDER_PRESET`, and the time limit on one ffmpeg run: `KILO_MEDIA_TIMEOUT_SEC` (a fixed limit), or `KILO_MEDIA_TIMEOUT_FLOOR_SEC` (default 180) and `KILO_MEDIA_TIMEOUT_FACTOR` (seconds allowed per second of media, default 10) |
| Motion graphics | `KILO_TEMPLATES_CACHE_DIR`, `KILO_TEMPLATES_CACHE_MAX_MB`, `KILO_TEMPLATES_CACHE_MAX_AGE_DAYS`, `KILO_CHROMIUM_PATH`, `REMOTION_LICENSE_KEY` |

### Worker

A worker sends a heartbeat for each running job. A job whose worker died is picked up by another after `KILO_JOB_EXPIRE_SEC`. On SIGTERM a worker takes no new jobs and hands back, without spending a retry, anything still running after `KILO_STOP_GRACE_MS`. On start and every five minutes, videos and renders left mid-work with no live job are queued again, at most three times, then failed.

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

No emoji. Icons are simple 2px-stroke line icons; on iOS, native chrome uses SF Symbols. Text contrast at least 4.5:1.

**Dark mode.** The app follows the system appearance. Dark values:

| Token | Dark |
|---|---|
| `ground` | `#0A0F1A` |
| `skyTint` | `#11244D`, same 36% fade |
| `surface` | `rgba(28,34,48,0.85)`, `hairline` border, no shadow |
| `ink` / `muted` | `#F2F5FA` / `#9AA4B5` |
| `accent` | `#4C7DFF` |
| `accentGloss` | `#3A72FF` to `#2257F0` |
| `track` | `#2A3346` |
| `hairline` / `outline` | `rgba(255,255,255,0.08)` / `rgba(255,255,255,0.16)` |
| `cut` / `record` | `#F0875A` / `#FF5A45` |
| Kept vs cut | Kept: solid `accent` bar on a `surface` row. Cut: transparent row, 1px `cut` outline, struck `muted` text. |

The recorder is dark in both modes.

**iOS 26.** Liquid Glass is the control layer only: tab bar, header buttons, floating toolbars, recorder controls, sheets, menus, toasts and small controls over video. Content (cards, transcript rows, chips, lists, the scrub strip) is never glass. One filled accent element per screen, its primary action. `docs/design/ios-redesign.md` is the screen-by-screen brief, with the motion and haptics spec and the fallbacks for older iOS, Android and web.
