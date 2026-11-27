# Real-speech recordings for phase 0

**These are not creator recordings.** They are assembled from audiobook read speech
(LibriSpeech), one real speaker per recording, cut and spliced to look like what a creator
uploads: script lines with pauses, abandoned starts and retakes, dead air, level changes, several
clips. They test Kilo on real voices, real speech-to-text timing error and real room tone. They do
not test real creator delivery: unscripted talk, fillers, laughter, phone microphones, music,
two people. See "What this proves" below.

## Sources

| Data | Licence | Used for |
|---|---|---|
| LibriSpeech dev-clean (Panayotov et al.), with Montreal Forced Aligner word times, as packaged in `gilkeyio/librispeech-alignments` on Hugging Face (alignments by Loren Lugosch) | CC BY 4.0 | the 12 recordings and their ground truth |
| DisfluencySpeech test split (`amaai-lab/DisfluencySpeech`, Wang and Herremans 2024): one speaker re-enacting Switchboard calls, every "uh" and "um" in the transcript | Apache 2.0 | how many fillers the `whisper` transcriber keeps (`npm run whisper:fillers` in packages/analyze) |

Looked at and not used: PodcastFillers (real podcast fillers, but its filler annotations are
non-commercial), AMI meetings (CC BY 4.0, spontaneous, but no word times in the Hugging Face copy
and several speakers per recording), CREMA-D and RAVDESS (the same short sentence many times, but
acted emotions, a dozen sentences, RAVDESS non-commercial), Buckeye and Switchboard (not openly
licensed), DisfluencySpeech's own alignments (one speaker only; kept for a later round).

Both datasets are pinned to a revision in `fetch.py`. Only 10 of the 28 parquet row groups of
dev-clean are read (about 130 MB); DisfluencySpeech's test split is 71 MB. Nothing downloaded is
committed: it all lives in `fixtures/real/.work/` (gitignored).

## Building

```sh
python3 -m venv fixtures/real/.work/venv
fixtures/real/.work/venv/bin/pip install pyarrow fsspec huggingface_hub numpy soundfile
fixtures/real/.work/venv/bin/python -I fixtures/real/fetch.py   # downloads into .work/cache
node fixtures/real/plan.mjs        # only to change the design: rewrites specs/*.json
node fixtures/real/generate.mjs    # builds .work/out/<id>/ (about 1 minute)
node fixtures/real/check.mjs       # checks the ground truth against the audio
```

`generate.mjs` takes `--only <id>`, `--out <dir>`, `--specs <dir>`, `--cache <dir>` and refuses
anything else. Output per recording, in the format of `fixtures/generate.mjs`: `<clip>.mp4`
(a plain coloured frame, H.264, AAC at 48 kHz), `<clip>.words.json` and `manifest.json`. Each MP4
also carries its ground-truth words in the `comment` tag (`kilo-words:`), so the `fixture`
transcriber reads the ground truth back: that is how `npm run score:real -- --truth` separates
decider errors from transcription errors.

Scoring (in packages/analyze): `npm run score:real` (whisper) and `npm run score:real -- --truth`.

## How a recording is assembled

`plan.mjs` writes one spec per recording, seeded per speaker:

- **One speaker, one chapter.** 5 to 9 lines (LibriSpeech utterances of 1.6 to 7.5 s, every word
  aligned) read in book order from one chapter, so the room is the same. real_174 mixes two
  chapters: its repeats are in a chapter with too few other lines.
- **Retake groups.** Every two or three lines, one line gets retakes, in turn: one abandoned start
  then the full line; two abandoned starts (each longer) then the full line; or an abandoned start
  at the end of a clip with the full line opening the next clip. An abandoned start stops at a
  real word boundary (MFA's), preferring one with a natural pause after it; if the next word
  follows without a pause, the cut fades over the first 8 ms of that word, as a voice breaking
  off does.
- **Real repeats.** Where LibriSpeech has them, the attempts are different readings by the same
  speaker: speaker 174 reads "The wandering singer" on its own twice and then "The wandering
  singer approaches them with his lute"; speakers 3081 and 777 have two different sentences that
  open with the same six words, so the abandoned start is the opening of one reading and the full
  line is the other. Elsewhere the abandoned start is the opening of the full line's own audio,
  so the two attempts sound identical up to the break (easier for speech-to-text than a real
  second attempt).
- **Pauses** between lines: 0.25-0.7 s (55%), 0.8-2.5 s (30%), 2.5-5.5 s (15%); 0.4-1.6 s
  before a retry; 0.3-1.5 s lead-in and 0.5-2 s tail per clip.
- **Room tone, not digital silence.** Each line keeps up to 0.3 s of its own recording's
  silence on each side; pauses are filled with the speaker's own quiet stretches (before, after
  and between words in their other utterances, with breaths and clicks screened out), taken from
  the line next to the pause or, when it has too little, from stretches within 3 dB of its level,
  joined with 20 ms crossfades.
- **Levels.** Every line ±1.5 dB; a second or third clip 4-9 dB quieter or 2-5 dB louder.
- **Clips.** 1 to 3 MP4s per recording at 30 or 60 fps, one landscape (real_2035).

| Recording | Speaker | Clips | Length | Script | Lines | Retake groups | Clip levels (dB) |
|---|---|---|---|---|---|---|---|
| real_1272 | M | 1 | 36.2 s | yes | 7 | 1: one abandoned start | 0 |
| real_1462 | F | 1 | 52.3 s | yes | 8 | 2: two abandoned starts; one | 0 |
| real_174 | M | 2 | 48.9 s | yes | 5 | 2: two real separate readings of the opening, then the line; one | 0 / +4.1 |
| real_2035 | F | 2 | 46.5 s | yes | 7 | 2 | 0 / +2.1 |
| real_2277 | F | 3 | 54.8 s | no | 8 | 2 | 0 / +3.6 / +3.8 |
| real_2428 | M | 2 | 41.4 s | no | 8 | 2 | 0 / -7.1 |
| real_251 | M | 1 | 59.8 s | no | 9 | 1 | 0 |
| real_3081 | F | 1 | 51.1 s | no | 8 | 3: one from a different real reading; two; one | 0 |
| real_3752 | M | 2 | 47.0 s | yes | 8 | 1: abandoned in clip 1, said in full in clip 2 | 0 / +3.2 |
| real_6313 | F | 1 | 62.9 s | no | 9 | 2 | 0 |
| real_777 | M | 2 | 51.5 s | no | 6 | 2: abandoned in clip 1, full in clip 2; one from a different real reading | 0 / +2.6 |
| real_7976 | M | 1 | 58.9 s | no | 7 | 2 | 0 |

12 recordings, 19 clips, 611 s, 22 retake groups, 5 female and 7 male readers.

## Held-out sets

The 12 recordings above are the development set: pipeline changes were made while looking at
them. Two more sets check a change on recordings it was not designed on. They use the same
construction rules and other LibriSpeech speakers, already in the cache (no extra download). The
speakers were fixed before either set was scored: every speaker the dev set does not use whose
best chapter has at least 5 usable lines, in speaker-number order, dealt in turn to `heldout` and
`fresh`. The designs cycle through the dev set's range: 5 to 9 lines, 1 to 3 clips, with and
without a script, some at 60 fps, one landscape. They have no real-repeat retakes.

| Set | Specs | Output (gitignored) | Recordings | Clips | Length | Retake groups (as scored) | Readers |
|---|---|---|---|---|---|---|---|
| heldout | `specs-heldout/` | `.work/out-heldout/` | 13 | 22 | 637 s | 16 | 8 F, 5 M |
| fresh | `specs-fresh/` | `.work/out-fresh/` | 12 | 20 | 535 s | 13 | 7 F, 5 M |

```sh
node fixtures/real/plan.mjs --set heldout      # only to change the design: rewrites specs-heldout/*.json
node fixtures/real/generate.mjs --specs fixtures/real/specs-heldout --out fixtures/real/.work/out-heldout
cd packages/analyze && KILO_REAL_FIXTURES=../../fixtures/real/.work/out-heldout npm run score:real   # or -- --truth
```

`plan.mjs` with no `--set` (or `--set dev`) still writes exactly the committed `specs/`.

## Ground truth

Units are the runs of a line's words between pauses of 0.1 s or more (MFA times moved onto the
clip), so a decider shortening a reader's pause inside a sentence is not counted as clipping it.
A unit of a full line is kept (`speech`); an abandoned start is cut (`false_start`, or `retake`
for a complete earlier reading); pauses of 0.3 s or more are `dead_air` units. Retake groups are
the `group` field, as in the synthetic fixtures. The ground-truth transcript has the words with a
capital at the start of each line and a full stop at the end of each complete one; an abandoned
start has no punctuation.

`check.mjs` checks the boundaries by energy, on the MP4s read back at 16 kHz: of 366 unit edges,
the loudest 10 ms within 40 ms outside the edge is a median 3.5 dB (starts) and 5.3 dB (ends) over
the room tone; 16 edges have 20 ms or more of sound (12 dB over room tone) just outside, and 9
have voiced sound there. So MFA's edges are mostly right, a few are early by a decay or a breath,
and a few are late: scoring found three MFA edges that sit in room tone well past the sound
(real_251 "which" starts 0.4 s before its sound, real_3081 "me" is placed 0.2 s after it, real_2277
"work" ends 30 ms late). Those are counted as clipped words all the same: the scorer measures
against MFA's times and is not adjusted.

## What this proves, and what it does not

It shows how the pipeline does on real voices, real reading pauses, real room noise of varying
level, and real Whisper output (its timing error, punctuation, mishearing and hallucinations)
over 12 speakers. It does not show how it does on creators: read speech is fluent, these speakers
have no fillers, the abandoned starts are mostly cut from the same audio as the full line, the
room tone was stitched, every recording was made in a quiet room with a good microphone, and the
retake structure was designed by us, not by a person losing their place.
