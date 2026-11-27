# Kilo: AI video editor

Implementation plan. Kilo takes a creator's raw clips, or records them against a script, and returns a tight vertical video ready for TikTok or Instagram. Creators work in batches and never touch a timeline.

Mock-up: https://claude.ai/artifact/8rk4supczNVodjAtLtgfvw

## 1. What the product does

| Capability | Behaviour |
|---|---|
| Cut | Removes dead air, false starts and retakes. Keeps the last good take of each line. |
| Polish | Punch-in zoom on cuts, loudness normalisation, a small set of transitions, slow pan (Ken Burns) on stills. |
| Review | Scrub strip plus transcript. Tap a line to cut or restore it. No timeline. |
| Batch | Many videos in one job, with a notification when they finish. |
| Record | Optional teleprompter. One clip per script line, with keep, retake and delete. 1080p at 60 fps. |
| B-roll | The creator adds clips for a specific video; Claude places them against the script. |
| Motion graphics | Claude picks from a fixed set of templates and fills in words and timing. |
| Variations | Several hooks (and later calls to action) on one body. |
| Modes | General, UGC ad, TikTok Shop. Presets over one pipeline. |
| Captions | Optional burn-in, off by default. |
| Goals | Videos-per-week target with reminders. |

## 2. How an edit works

Claude edits the transcript, not the video. Every feature reads or writes one JSON document per video, the edit decision list (EDL).

1. **Ingest.** Clips upload with a resumable protocol. The server makes a low-resolution proxy and a mono audio track for each clip.
2. **Transcribe.** Word-level timestamps, with filler words preserved.
3. **Detect silence.** ffmpeg `silencedetect` gives exact gap boundaries, which refine the cut points.
4. **Decide.** Claude receives the transcript, the gaps, the mode preset and, when present, the script and B-roll descriptions. It returns the EDL as structured output.
5. **Snap.** Code moves every cut to a word boundary with a small padding, so no syllable is clipped. Claude never chooses frame-exact times.
6. **Review.** The app plays the proxy and skips cut ranges on the client. Toggling a line edits the EDL, with no re-render.
7. **Render.** On export, ffmpeg produces 1080 × 1920 at the source frame rate, applying zooms, B-roll, graphics and audio levelling.

### EDL sketch

```json
{
  "videoId": "…",
  "fps": 60,
  "segments": [
    { "clipId": "c1", "start": 3.42, "end": 7.10, "keep": false, "reason": "false_start" },
    { "clipId": "c1", "start": 7.10, "end": 11.36, "keep": true, "zoom": 1.12 }
  ],
  "overlays": [
    { "type": "broll", "assetId": "b3", "at": 7.4, "duration": 2.4 },
    { "type": "graphic", "template": "bold-title", "props": { "text": "Nobody tells you" }, "at": 12.0, "duration": 1.6 }
  ],
  "captions": { "enabled": false, "style": "default" },
  "variants": [{ "id": "hook-a", "prepend": ["s2"] }]
}
```

## 3. Architecture

One TypeScript monorepo, so the app, the server and the graphics templates share the EDL types.

| Part | Choice | Notes |
|---|---|---|
| App | Expo (React Native), expo-router | Dev client build, not Expo Go, because the camera library is native. |
| Camera | react-native-vision-camera | Select a 1080p60 format explicitly; fall back to 30 fps on devices without one. |
| Auth, database, storage | Supabase | Resumable uploads into storage; row-level security per user. |
| Job queue | Postgres-backed queue (pg-boss) | No extra infrastructure. One job per pipeline step, so a failure retries only that step. |
| Worker | Node service in a container with ffmpeg and Chromium | Long-running renders; scale by adding workers. |
| Transcription | Hosted speech-to-text with word timestamps | Chosen in phase 0 by testing on real footage. Must keep filler words. |
| Edit decisions | Claude, structured output | Start on the most capable model (`claude-fable-5-2`) to prove quality, then test `claude-sonnet-5-5` for batch volume. |
| B-roll understanding | Claude vision on sampled frames | Produces a one-line description per clip. The creator labels nothing. |
| Motion graphics | Remotion (React components rendered to video) | Used under its free licence: individuals and companies of up to three people. A paid licence is needed only past that size. |
| Notifications | Expo push | Batch finished, weekly goal reminder. |

### Repo layout

```
app/          Expo app
server/       API and worker (pipeline steps, ffmpeg, queue)
packages/edl/ EDL types, validation, cut-snapping logic
templates/    Motion graphic templates
fixtures/     Raw test recordings and expected cuts
```

The existing landing-page generator files are removed when the app is scaffolded. They remain in git history.

### Data model

`users`, `batches`, `videos`, `clips`, `transcripts`, `edls` (versioned per video), `broll_assets`, `renders`, `styles` (saved presets), `goals`.

## 4. Phases

Each phase ends with something a creator can use.

| Phase | Builds | Done when |
|---|---|---|
| 0. Pipeline proof | Steps 1 to 5 and 7 as a command-line tool: clips in, cut and zoomed 9:16 file out. | On 10 real recordings, no clipped words and the right take is kept in at least 9 of 10 retake groups. |
| 1. The app | Sign-in, upload, batch queue, review screen with scrubbing, export to camera roll, push notification. | A creator uploads 30 videos, fixes mistakes by tapping, and saves all of them without help. |
| 2. Recorder | Script entry, teleprompter, one clip per line, 60 fps capture. | A recorded video needs fewer manual fixes than an uploaded one. |
| 3. B-roll | Per-video B-roll bin, frame-sampled descriptions, Claude placement, slow pan on stills, swap and remove. | Placements are accepted without a swap most of the time. |
| 4. Motion graphics | Five templates: bold title, numbered list, stat callout, keyword pop, price tag. | Each template renders correctly on text of any reasonable length. |
| 5. Variations and modes | Hook variations, UGC ad and TikTok Shop presets, optional burned-in captions. | One recording produces three distinct, usable openings. |
| 6. Habit and reach | Weekly goal, reminders, stock B-roll from free-licence libraries, direct posting. | Direct posting passes the platforms' app review. |

Phases 3 to 5 are the likely paid tier. The free tier is cut, review and export.

### Where each phase stands

Each "done when" test below has a repeatable check in this repository (command in brackets). The checks run offline, against stand-ins for the outside services, on recordings with known right answers. None of it has run on a phone or against a real account yet.

| Phase | Measured here | Still to prove |
|---|---|---|
| 0 | Synthetic recordings (`npm run score` in packages/analyze): 0 clipped words, right take in 19 of 19 retake groups. Real read speech (LibriSpeech, `npm run score:real`, local Whisper): on the 12 recordings the rules were developed on, 22/22 retakes and 4 clipped words (0 with the true transcript). On 25 recordings from other speakers, built before the last rule was settled: 13/16 and 8/13 retakes, 6 and 12 clipped words; with the true transcript 16/16 with 1 clipped, and 13/13 with 0. So the cut logic nearly meets the line when the transcript is right, and the remaining errors come mostly from Whisper's text (invented or dropped repeats, abandoned starts closed with a full stop). Phase 0 is not met on real speech with the local transcriber. | The test itself, on 10 of the creator's own recordings: real retakes, fillers and phone microphones. Whisper drops about a third of "um" and "uh". |
| 1 | One batch of 30 videos through the real app and server in a browser (`npm run e2e:batch30` in app): upload with a dropped connection, analysis, review, fixes by tapping, every hook version exported and checked frame by frame, posted. An Android release build compiles, and an iOS Release build compiles on Xcode 26.6 (both unsigned so far; app/README.md). | A person doing it without help. On a phone: background uploads, saving to the gallery, the share sheet, push. Supabase sign-in and storage on a real project. iOS. |
| 2 | Fifteen performances, each as a recorder session and as an upload (`npm run score:recorded`): recorded needs 0 fixes, uploaded 7. | 60 fps capture on a real phone (the browser recorder is what was tested). |
| 3 | The creator's B-roll lands on its obvious line 18 of 19 times, never breaking an overlay rule (`npm run score:broll`). | Claude's descriptions and placement with a real key; the offline describer and placement were measured. Acceptance by creators. |
| 4 | 5 templates × 3 themes × 16 kinds of text, 240 of 240 with no clipping, overflow, overlap or missing glyphs, using only bundled fonts (`npm run sweep` in templates). | Motion during entrances and exits is not measured. Scripts without a bundled font (Traditional Chinese, Bengali, Tamil and others). |
| 5 | Every hook version of nine recordings rendered and traced frame by frame (`npm run check:variants-render`). Distinct openings: three on 4 recordings, two on 4, one on 1; short recordings fall back to title cards. | Whether the openings read as distinct on real footage, and Claude's hook choices. |
| 6 | Weekly goal, reminders, stock B-roll lookup. | Direct posting is not built: it needs the platforms' app review. Export goes to the camera roll and the share sheet. |

## 5. Design

Light and calm, in the spirit of the reference the brief named, with Kilo's own wordmark and no third-party assets.

| Token | Value |
|---|---|
| Ground | `#F5F8FC`, with a soft sky tint `#D9E8FF` fading from the top |
| Surface | White at 80% opacity, 1px border `rgba(12,24,48,0.08)`, soft blue shadow, 20px radius |
| Ink / muted | `#0B1220` / `#566074` |
| Accent | `#1F5EFF`; primary buttons use a `#2A66FF` to `#1A52E8` gloss |
| Cut marker | `#B4441E` outline on white (differs from kept segments by lightness, not hue alone) |
| Type | Inter; headings 600 to 700 with tight tracking |
| Wordmark | Lowercase "kilo", weight 700 |
| Controls | Pill buttons, 44px minimum touch target |

The camera screen stays dark behind white glass panels, so the script is readable over any background.

## 6. Risks

| Risk | Response |
|---|---|
| Cuts clip words or keep the wrong take | Phase 0 exists to measure this. Snapping is done in code; the review screen fixes the rest in one tap. |
| Large uploads on mobile data | Record at 1080p, not 4K. Resumable uploads that continue in the background. |
| iPhone variable frame rate causes audio drift | Normalise every clip to constant frame rate at ingest. |
| Per-video cost at batch volume | Cost scales with minutes transcribed and rendered. Measure it in phase 0 before setting prices. |
| Copyright on B-roll | Creator's own clips first; stock only from libraries that allow commercial use. |
| Platform posting APIs need review | Ship "save to camera roll" and the share sheet first. |

## 7. Open questions

- Which transcription provider keeps filler words and gives the tightest word timings on phone audio.
- Whether review playback by seeking over cut ranges is smooth enough on older phones, or needs a quick proxy render.
- Batch size and feature limits for the free tier.
