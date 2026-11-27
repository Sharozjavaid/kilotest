# "Other" set: pre-registration

Written on 2026-11-27, before any pipeline change it is meant to check, and before anyone looked at
a single cut on it.

## What the set is

- Source: LibriSpeech **test-other** (CC BY 4.0), MFA alignments from
  `gilkeyio/librispeech-alignments@0daa1eb4`, all 30 parquet row groups (2938 utterances, 353 MB),
  fetched with `fetch.py librispeech-test-other` into `.work/cache/librispeech-test-other/`.
  test-other is the harder, noisier half of LibriSpeech's test data. Its 33 speakers are none of
  dev-clean's or test-clean's, so no speaker of dev, held-out, fresh or final is in it. (dev-other,
  33 more unheard speakers, is left untouched for a later round.)
- Selection rule: every test-other speaker whose best chapter has at least 5 usable lines (the rule
  `plan.mjs` uses for held-out, fresh and final; all 33 qualify), in speaker-number order, with the
  final set's design cycle (5 to 9 lines, 1 to 3 clips, script on every other one, some at 60 fps, a
  few landscape). Fixed by `node fixtures/real/plan.mjs --set other` before scoring.
- Built with `node fixtures/real/generate.mjs --specs fixtures/real/specs-other --out fixtures/real/.work/out-other --cache fixtures/real/.work/cache/librispeech-test-other`.
- 33 recordings, 57 clips, 1758 s, 47 retake groups, 17 F and 16 M readers.
  `check.mjs --out .work/out-other`: 582 unit edges; 60 starts and 101 ends have 20 ms or more of
  sound (12 dB over room tone) just outside the aligner's edge (final: 43 and 47 of 434), so the
  aligner's edges are looser here, ends especially.

## Scores of the code as it stood (commit aa4557f), totals only

Read with a totals-only runner; no per-recording row or per-cut detail was printed.

| Transcriber | Clipped words | Retakes right | Kept units full | Cut units cut | WER |
|---|---|---|---|---|---|
| Whisper base.en (int8, 2 threads, Kilo's prompt) | 48 | 37/47 (79%) | 461/492 | 82/90 | 10.1% |
| Ground truth (`--truth`) | 5 | 46/47 (98%) | 488/492 | 90/90 | 0.1% |

Whisper: 57 clips, 86 stretches transcribed again on their own, 0.348 CPU s per audio second (all
threads, second looks included). Phase 0's line (0 clipped words, the right take in at least 9 of
10 retake groups) is not met with Whisper (clipped words and retakes) nor with the true transcript
(clipped words).

## What will be run on it, once

The change to be checked is an optional acoustic check behind the `whisper` transcriber
(`KILO_WHISPER_ALIGN=ctc`: a small CTC character model, wav2vec2-base-960h, checking Whisper's
words and edges against the audio). Whether it becomes the default is decided on dev, held-out,
fresh and final only. When the code is finished: `npm run score:real` with the chosen default,
the same with the other setting (so both are on record), and `npm run score:real -- --truth`, with
`KILO_REAL_FIXTURES=../../fixtures/real/.work/out-other`. Those results are appended below and
reported against the plan's line whatever they are, and nothing is changed after them.

Caveat fixed in advance: wav2vec2-base-960h was fine-tuned on LibriSpeech's training speech (other
speakers, same kind of audiobook audio), so it is closer to this test than to a creator's phone.
A gain here is an upper bound on what the check gives on creators' recordings.

## Result, run once after the changes (added afterwards; nothing above was changed)

The change: `KILO_WHISPER_ALIGN=ctc`, made the default before this run on the development sets
(dev, held-out, fresh, final) alone. A CTC model's greedy reading of each clip is set against
Whisper's words: Whisper words it heard nothing of are dropped, and each kept word's edges are held
outside its CTC letters (packages/analyze/src/ctc.ts). Whisper base.en, 2 threads; Whisper's own
output was read from the cache written by the baseline run (same audio, model, prompt and script).

| Transcriber | Clipped words | Retakes right | Kept units full | Cut units cut | WER |
|---|---|---|---|---|---|
| Whisper base.en with the CTC check (default) | 34 | 38/47 (81%) | 468/492 | 82/90 | 9.7% |
| Whisper base.en, `KILO_WHISPER_ALIGN=none` | 48 | 37/47 (79%) | 461/492 | 82/90 | 10.1% |
| Ground truth (`--truth`) | 5 | 46/47 (98%) | 488/492 | 90/90 | 0.1% |

With the check off the totals equal the baseline above, so the path without the check is unchanged.
With it, 14 fewer clipped words (29% fewer) and one more retake group right. Of the kept units
that lose audio, those cut at an edge (80% or more kept) fall from 19 to 12; those lost whole (a
wrong take kept or a kept take cut) stay at 14. Dead air kept rises from 20.5% to 21.0% of the
output. Phase 0's line is still not met with Whisper (clipped words and retakes) nor with the true
transcript (clipped words).

Speed: Whisper 0.348 CPU s per audio second (second looks included), the CTC check 0.167 more
(model load of about 1 s per clip excluded; 0.19 with it on a 51 s clip), 0.52 in all, on 2 threads.
The CTC script peaks at about 1 GB of memory.
