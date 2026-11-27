# Devother set: pre-registration

Written on 2026-11-27, before any pipeline change it is meant to check, and before anyone looked at
a single cut on it. The previous untouched set (`specs-other/`) is spent: its cuts were looked at,
so from this round on it is a development set like dev, held-out, fresh and final.

## What the set is

- Source: LibriSpeech **dev-other** (CC BY 4.0), MFA alignments from
  `gilkeyio/librispeech-alignments@0daa1eb4`, all 29 parquet row groups (2864 utterances, 320 MB),
  fetched with `fetch.py librispeech-dev-other` into `.work/cache/librispeech-dev-other/`.
  dev-other is the noisier half of LibriSpeech's development data. Its 33 speakers are none of
  dev-clean's, test-clean's or test-other's, so no speaker of dev, held-out, fresh, final or other
  is in it (checked against every committed spec).
- Selection rule: every dev-other speaker that no earlier set uses whose best chapter has at least
  5 usable lines (the rule `plan.mjs` uses for held-out, fresh, final and other; all 33 qualify),
  in speaker-number order, with the final set's design cycle (5 to 9 lines, 1 to 3 clips, script on
  every other one, some at 60 fps, a few landscape). Fixed by
  `node fixtures/real/plan.mjs --set devother` before scoring. Adding `devother` to `plan.mjs`
  left every earlier set's specs byte-for-byte the same.
- Built with `node fixtures/real/generate.mjs --specs fixtures/real/specs-devother --out fixtures/real/.work/out-devother --cache fixtures/real/.work/cache/librispeech-dev-other`.
- 33 recordings, 57 clips, 1739 s, 47 retake groups, 16 F and 17 M readers.
  `check.mjs --out .work/out-devother`: 526 units (1052 edges); 54 starts and 102 ends have 20 ms
  or more of sound (12 dB over room tone) just outside the aligner's edge (other: 60 and 101 of
  582 units), so the aligner's edges are about as loose as on the other set, ends especially.

## Scores of the code as it stood (commit afc2d24), totals only

Read with a totals-only runner; no per-recording row or per-cut detail was printed. Whisper's
output was transcribed fresh (nothing cached) and cached for the final run.

| Transcriber | Clipped words | Retakes right | Kept units full | Cut units cut | WER |
|---|---|---|---|---|---|
| Whisper base.en with the CTC check (default; int8, 2 threads, Kilo's prompt) | 17 | 37/47 (79%) | 431/446 | 71/80 | 8.3% |
| Ground truth (`--truth`) | 3 | 45/47 (96%) | 444/446 | 77/80 | 0% |

Whisper: 57 clips, 79 stretches transcribed again on their own, 0.359 CPU s per audio second (all
threads, second looks included), the CTC check 0.164 more. Dead air kept: 17.9% of the output with
Whisper, 13.7% with the true transcript. Phase 0's line (0 clipped words, the right take in at
least 9 of 10 retake groups) is not met with Whisper (clipped words and retakes) nor with the true
transcript (clipped words).

## What will be run on it, once

The changes to be checked are to how the decider reads Whisper's punctuation and segmentation
(abandoned starts closed with a full stop, a restart of a line's opening words, script lines
joined across takes) and to the filler lexicon. They are developed on dev, held-out, fresh, final
and other only. When the code is finished: `npm run score:real` (Whisper with the CTC check, the
default) and `npm run score:real -- --truth`, with
`KILO_REAL_FIXTURES=../../fixtures/real/.work/out-devother`. Those results are appended below and
reported against the plan's line whatever they are, and nothing is changed after them.

## Result, run once after the changes (added afterwards; nothing above was changed)

The changes, made on dev, held-out, fresh, final and other alone (packages/analyze/src/heuristic.ts,
chunks.ts, text.ts): a sentence that the next utterance says again word for word and carries on is
an abandoned start whatever its full stop; a one-word start written with a comma ties to its
restart though Whisper's times shrank the pause; parallel phrases that open alike but change a
word ("o eternal everywhere / o eternal nowhere") are not restarts; pieces of an abandoned attempt
that the kept take says again are cut with it; with a script, a take of one line is not joined to
the next line as its lead-in, and a reading never joins a restart of its own opening; "No, no,
no." is one phrase, not "No," and an aside; a sentence-opening "Ah" that runs straight on is a
word, not a filler. Whisper base.en with the CTC check (the default), 2 threads; Whisper's and the
CTC model's output read from the cache written by the baseline run (same audio, model, prompt and
scripts).

| Transcriber | Clipped words | Retakes right | Kept units full | Cut units cut | WER |
|---|---|---|---|---|---|
| Whisper base.en with the CTC check (default) | 17 | 39/47 (83%) | 431/446 | 74/80 | 8.3% |
| Ground truth (`--truth`) | 2 | 46/47 (98%) | 444/446 | 79/80 | 0% |

Against the baseline above: with Whisper, two more retake groups right and three more abandoned
starts cut, clipped words unchanged (one kept line recovered, one lost); with the true transcript,
one more group right and one clipped word fewer (a read "Ah" kept, one kept line recovered, two
lost). Dead air kept 17.8% (Whisper) and 13.7% (truth) of the output. Phase 0's line is not met with
Whisper (clipped words and retakes) nor with the true transcript (clipped words).

Looked at after this run, and not changed: both new losses come from the script-line guards. The
script line "How can you how can you speak of it" says its own opening twice, so the rule that a
reading never says its opening twice cut the first "How can you"; and "My father" was taken for the
opening of a shorter script line ("My father's is a comparatively humble residence") instead of a
lead-in to "My father she burst out suddenly...". The remaining Whisper group errors are mostly
abandoned starts Whisper wrote as finished or joined to the next line, and a list read as
"Neck / moderately long slightly arched / ..." that the decider took for retakes.
