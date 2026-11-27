# Final set: pre-registration

Written on 2026-11-27, before any pipeline change it is meant to check, and before anyone looked at
a single cut on it.

## What the set is

- Source: LibriSpeech **test-clean** (CC BY 4.0), MFA alignments from
  `gilkeyio/librispeech-alignments@0daa1eb4`, parquet row groups 0-7 (800 utterances, 113 MB),
  fetched with `fetch.py librispeech-test` into `.work/cache/librispeech-test/`. test-clean's 40
  speakers are none of dev-clean's, so no speaker of dev, held-out or fresh is in it.
- Speakers: every test-clean speaker in that cache whose best chapter has at least 5 usable lines
  (the rule `plan.mjs` uses for held-out and fresh), in speaker-number order, with the same design
  cycle (5 to 9 lines, 1 to 3 clips, script on every other one, some at 60 fps, a few landscape).
  Fixed by `node fixtures/real/plan.mjs --set final` before scoring.
- Built with `node fixtures/real/generate.mjs --specs fixtures/real/specs-final --out fixtures/real/.work/out-final --cache fixtures/real/.work/cache/librispeech-test`.
- 30 recordings, 50 clips, 1480 s, 42 retake groups as scored, 16 F and 14 M readers.
  `check.mjs` on it: 434 unit edges; 43 starts and 47 ends have 20 ms or more of sound just outside
  the aligner's edge (more than dev's 16 of 366), so the aligner's edges are a little looser here.

## Scores of the code as it stood (commit 3a4e87c), totals only

Read with a totals-only runner; no per-recording row or per-cut detail was printed.

| Transcriber | Clipped words | Retakes right | Kept units full | Cut units cut | WER |
|---|---|---|---|---|---|
| Whisper base.en (int8, 2 threads, Kilo's prompt) | 33 | 32/42 (76%) | 347/363 | 60/71 | 6.2% |
| Ground truth (`--truth`) | 4 | 40/42 (95%) | 360/363 | 68/71 | 0% |

Phase 0's line (0 clipped words, the right take in at least 9 of 10 retake groups) is not met with
either transcriber.

## What will be run on it, once

When the code changes and the model choice are finished, developed on dev, held-out and fresh only:
`npm run score:real` with the chosen default model, and `npm run score:real -- --truth`, with
`KILO_REAL_FIXTURES=../../fixtures/real/.work/out-final`. Those two results are reported against
the plan's line whatever they are, and nothing is changed after them.

## Result, run once after the changes (added afterwards; nothing above was changed)

Code as it stood at the end of the round, Whisper base.en (the default), 2 threads:

| Transcriber | Clipped words | Retakes right | Kept units full | Cut units cut | WER |
|---|---|---|---|---|---|
| Whisper base.en | 20 | 36/42 (86%) | 353/363 | 64/71 | 5.4% |
| Ground truth (`--truth`) | 4 | 40/42 (95%) | 360/363 | 68/71 | 0% |

Phase 0's line is not met with Whisper (clipped words and retakes) nor with the true transcript
(clipped words). Speed: 0.21 s per audio second wall, 0.34 CPU s per audio second (all threads),
second looks included (52 stretches transcribed again, for 50 clips).

