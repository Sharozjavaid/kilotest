# kilo

AI video editor for short-form creators. Upload raw clips, or record them against a script, and get back a tight vertical video for TikTok or Instagram: dead air, false starts and retakes cut; zooms on the cuts; B-roll, motion graphics and hook variations placed for you. You fix mistakes by tapping lines of the transcript. There is no timeline.

- [`PLAN.md`](PLAN.md): what is being built and why.
- [`docs/CONTRACTS.md`](docs/CONTRACTS.md): how the parts fit together, the API, and the design tokens.
- [`docs/mockup/`](docs/mockup): the approved screen designs.

## What is in the repository

Six independent npm projects (no workspace) that share one contracts package.

| Directory | What it is |
|---|---|
| `packages/edl` | Shared contracts: the edit decision list (EDL) schema, settings and mode presets, the motion graphic catalog, timeline helpers, API bodies, pipeline interfaces. Consumers import its built `dist/`, so run `npm run build` there after changing it. |
| `packages/analyze` | Ingest, transcription providers, silence detection, the cut decider (Claude, with an offline heuristic), cut snapping, B-roll and graphic placement, hook variants. |
| `packages/render` | EDL to MP4 with ffmpeg: cuts, zooms, transitions, B-roll with slow pan, graphics, captions, loudness. |
| `templates` | Five motion graphic templates in three themes, rendered with Remotion to video with transparency. |
| `server` | HTTP API, PostgreSQL migrations, storage, auth, job queue and worker, push, weekly goal, and the `kilo` command-line tool. |
| `app` | The Expo (React Native) app. |
| `fixtures` | A generator for synthetic test recordings with known right answers. |

## Try it with no accounts or keys

Everything runs offline by default: test recordings carry their own transcripts, a rule-based decider makes the cuts, files go to local disk, and sign-in is a development token.

You need Node 22, ffmpeg, espeak-ng (to generate the test recordings) and PostgreSQL 16 (for the server).

```sh
# once: install each project
for d in packages/edl packages/analyze packages/render templates server app; do (cd $d && npm install); done
(cd packages/edl && npm run build)

# make the test recordings
node fixtures/generate.mjs

# edit a recording from the command line: no database, no server
cd server
npm run kilo -- edit ../fixtures/out/routine/clip1.mp4 --out .work/out/routine.mp4
```

Run the app in a browser against an in-memory stand-in for the server:

```sh
cd app && npm run start:mock
```

Run the real app against the real server on your machine: see [`server/README.md`](server/README.md) and [`app/README.md`](app/README.md).

## Checks

| Command | Where | What it proves |
|---|---|---|
| `npm test`, `npm run typecheck` | every project | Unit and integration tests. |
| `npm run score` | `packages/analyze` | Cut accuracy on the synthetic recordings: no clipped words, right take kept. |
| `npm run score:real` | `packages/analyze` | The same on recordings built from real read speech, transcribed by local Whisper (run `npm run whisper:setup` and `node fixtures/real/generate.mjs` first; see `fixtures/real/README.md`). |
| `npm run score:recorded`, `score:variants`, `score:broll`, `score:batch30`, `check:variants-render` | `packages/analyze` | The plan's phase tests: recorder versus upload, distinct hook openings, B-roll placement, the 30-video set, hook renders traced frame by frame. |
| `npm run sweep` | `templates` | Every template and theme on 16 kinds of text, using only the bundled fonts. |
| `npm run test:real` | `server` | Every test recording through HTTP, the queue, real analysis, rendering and graphics, checked frame by frame. |
| `npm run e2e` | `app` | The real app driving the real server in a browser: upload, review, B-roll, export, recorder, styles and goal, failure cases. |
| `npm run e2e:batch30` | `app` | One batch of 30 videos, start to finish, in about 25 minutes. |

## Going live

Nothing in this list has been run from this repository yet; each is written and tested against stand-ins.

| You need | For | Set |
|---|---|---|
| A Supabase project | Sign-in, PostgreSQL, file storage | `KILO_AUTH=supabase`, `KILO_STORAGE=supabase`, `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`; in the app `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY` |
| An Anthropic API key | Claude makes the cut decisions and describes B-roll | `ANTHROPIC_API_KEY` |
| Speech-to-text | Word-level transcripts | Free and local: `KILO_TRANSCRIBER=whisper` (needs Python on the worker; image built with `--build-arg KILO_WITH_WHISPER=1`). Or a key: `DEEPGRAM_API_KEY`, or `OPENAI_API_KEY` for an OpenAI-compatible endpoint |
| A container host | The API and the worker (`server/Dockerfile`: Node, ffmpeg, Chromium, fonts) | see `server/.env.example` |
| An Expo account and device builds | The phone app, push notifications | `eas init`, then `eas build`; see `app/README.md`. An Android APK for your own phone can also be built locally without an account (`app/README.md`, "Android build") |
| Optional: a Pexels key | Stock B-roll | `PEXELS_API_KEY` |

Motion graphics use Remotion under its free licence, which covers individuals and companies of up to three people. No key is needed. A paid company licence (`REMOTION_LICENSE_KEY`) only becomes necessary if the company grows past three people.

Before trusting the cuts, run the plan's first test on about ten of your own recordings. The numbers so far come from computer-generated speech and from audiobook readings assembled into takes, not from creator footage.
