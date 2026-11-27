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
| LibriSpeech dev-clean (Panayotov et al.), with Montreal Forced Aligner word times, as packaged in `gilkeyio/librispeech-alignments` on Hugging Face (alignments by Loren Lugosch) | CC BY 4.0 | the 12 recordings and their ground truth, and the held-out and fresh sets |
| LibriSpeech test-clean, from the same package (first 8 of its 27 row groups, 113 MB) | CC BY 4.0 | the final set (`specs-final/`) |
| LibriSpeech test-other, from the same package (all 30 row groups, 353 MB) | CC BY 4.0 | the "other" set (`specs-other/`) |
| LibriSpeech dev-other, from the same package (all 29 row groups, 320 MB) | CC BY 4.0 | the devother set (`specs-devother/`) |
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

### The final set

Once held-out and fresh had been looked at, neither could give a clean number. The final set was
built before the next round of pipeline changes and scored once, at the end of it: LibriSpeech
**test-clean**, whose 40 speakers are none of dev-clean's. Every test-clean speaker in the cache
with a chapter of at least 5 usable lines, in speaker-number order, with the same design cycle.
Its score on the code as it stood was written down before any change, in totals only
(`specs-final/PREREGISTRATION.md`); nobody looked at its cuts until the changes were finished.

| Set | Specs | Output (gitignored) | Recordings | Clips | Length | Retake groups (as scored) | Readers |
|---|---|---|---|---|---|---|---|
| final | `specs-final/` | `.work/out-final/` | 30 | 50 | 1480 s | 42 | 16 F, 14 M |

```sh
fixtures/real/.work/venv/bin/python -I fixtures/real/fetch.py librispeech-test   # into .work/cache/librispeech-test (113 MB)
node fixtures/real/plan.mjs --set final        # only to change the design: rewrites specs-final/*.json
node fixtures/real/generate.mjs --specs fixtures/real/specs-final --out fixtures/real/.work/out-final --cache fixtures/real/.work/cache/librispeech-test
cd packages/analyze && KILO_REAL_FIXTURES=../../fixtures/real/.work/out-final npm run score:real   # or -- --truth
```

`check.mjs --out .work/out-final`: of 868 unit edges, 43 starts and 47 ends have 20 ms or more of
sound just outside the aligner's edge, about as in held-out and fresh. (The manifests in
`.work/out-final/` were built before `generate.mjs` named the split in its `source` line, so they
say dev-clean there; a rebuild into another folder is identical apart from that line.)

### The "other" set

The final set was spent by the round that followed it (its cuts were looked at). The next round,
the CTC check on Whisper's words (packages/analyze/src/ctc.ts), was checked on a new set built
before it: LibriSpeech **test-other**, the harder, noisier half of LibriSpeech's test data, whose
33 speakers none of the other sets use. Every one of them (all have a chapter of at least 5 usable
lines), in speaker-number order, with the final set's design cycle. Its baseline was written down in
totals only before any code changed (`specs-other/PREREGISTRATION.md`), and it was scored once at
the end. It was spent by the round after (its cuts were looked at); dev-other is the set after it.

| Set | Specs | Output (gitignored) | Recordings | Clips | Length | Retake groups (as scored) | Readers |
|---|---|---|---|---|---|---|---|
| other | `specs-other/` | `.work/out-other/` | 33 | 57 | 1758 s | 47 | 17 F, 16 M |

```sh
fixtures/real/.work/venv/bin/python -I fixtures/real/fetch.py librispeech-test-other   # into .work/cache/librispeech-test-other (353 MB)
node fixtures/real/plan.mjs --set other        # only to change the design: rewrites specs-other/*.json
node fixtures/real/generate.mjs --specs fixtures/real/specs-other --out fixtures/real/.work/out-other --cache fixtures/real/.work/cache/librispeech-test-other
cd packages/analyze && KILO_REAL_FIXTURES=../../fixtures/real/.work/out-other npm run score:real   # or -- --truth
```

`check.mjs --out .work/out-other`: of 582 unit edges, 60 starts and 101 ends have 20 ms or more of
sound just outside the aligner's edge: its edges are looser here than on any other set, ends
especially.

### The devother set

The round on Whisper's punctuation and segmentation (below) was checked on LibriSpeech
**dev-other**, the noisier half of LibriSpeech's development data, whose 33 speakers none of the
other sets use. Same rule as `other`: every speaker no earlier set uses with a chapter of at least
5 usable lines (all 33), in speaker-number order, the final set's design cycle. Its baseline was
written down in totals only before any code changed (`specs-devother/PREREGISTRATION.md`), and it
was scored once at the end.

| Set | Specs | Output (gitignored) | Recordings | Clips | Length | Retake groups (as scored) | Readers |
|---|---|---|---|---|---|---|---|
| devother | `specs-devother/` | `.work/out-devother/` | 33 | 57 | 1739 s | 47 | 16 F, 17 M |

```sh
fixtures/real/.work/venv/bin/python -I fixtures/real/fetch.py librispeech-dev-other   # into .work/cache/librispeech-dev-other (320 MB)
node fixtures/real/plan.mjs --set devother     # only to change the design: rewrites specs-devother/*.json
node fixtures/real/generate.mjs --specs fixtures/real/specs-devother --out fixtures/real/.work/out-devother --cache fixtures/real/.work/cache/librispeech-dev-other
cd packages/analyze && KILO_REAL_FIXTURES=../../fixtures/real/.work/out-devother npm run score:real   # or -- --truth
```

`check.mjs --out .work/out-devother`: of 526 units, 54 starts and 102 ends have 20 ms or more of
sound just outside the aligner's edge, about as on the other set.

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

## Results (heuristic decider, 2026-11-27)

Clipped words and retake groups right, per set, before and after the round that added the final
set (decider fixes, a second look at stretches Whisper got wrong, edges leaned into pauses; see
packages/analyze/src/whisper.ts). Rules were developed on dev, held-out and fresh; the final set
was scored once before and once after, nothing in between.

| Set | Whisper base.en, before | after | True transcript, before | after |
|---|---|---|---|---|
| dev (12) | 4, 22/22 | 2, 22/22 | 0, 22/22 | 0, 22/22 |
| held-out (13) | 6, 13/16 | 0, 16/16 | 1, 16/16 | 0, 16/16 |
| fresh (12) | 12, 8/13 | 0, 13/13 | 0, 13/13 | 0, 13/13 |
| **final (30)** | 33, 32/42 | **20, 36/42** | 4, 40/42 | **4, 40/42** |

The two clipped words left on dev are one word, real_3081 "me.", which the aligner places 0.2 s
after its sound. On the final set phase 0's line is not met with either transcriber: with Whisper,
7 of the 20 are line-final words cut inside their sound (Whisper ended them early), and 6 retake
groups go wrong, 4 of them from Whisper's text; with the true transcript the 4 clipped words are
a read "Ah" cut by the filler lexicon (counted twice) and the end of a kept take cut with the
abandoned starts before it (two units), and 2 groups go wrong.

Models, with the code as it now stands (dev / held-out / fresh; CPU seconds per audio second on 2
threads, all threads counted, second look included; fillers kept with Kilo's prompt, DisfluencySpeech):

| Model | Retakes right | Clipped | CPU s per audio s | Fillers kept |
|---|---|---|---|---|
| base.en (default) | 22/22, 16/16, 13/13 | 2, 0, 0 | 0.31-0.38 (first pass 0.10-0.12) | 92/134 (69%); 29/42 on the first 60 |
| small.en | 20/22, 13/16, 11/13 | 1, 2, 2 | 0.44-0.49 (first pass 0.28-0.32) | 99/134 (74%); 28/42 on the first 60 |
| large-v3-turbo (int8) | 18/22, 14/16, 10/13 | 2, 5, 0 | 2.4-2.7 (first pass 1.33-1.50) | 33/42 (79%) on the first 60 |

The bigger models write a phrase said twice as one copy more often (a better language model tidies
the speech), which is exactly what cutting retakes needs to see, so base.en stays the default.
(These model rows were measured before the CTC check below, with Whisper alone.)

### The CTC check (`KILO_WHISPER_ALIGN=ctc`, the default since this round)

A small CTC character model (wav2vec2-base-960h as ONNX, fp32, 378 MB, no language model) reads
each clip, and its greedy reading is set against Whisper's words (packages/analyze/src/ctc.ts):
Whisper words with no CTC counterpart, in a stretch where the model wrote no letter for 0.3 s or
more, are dropped (fillers and the halves of a word Whisper split stay), and each kept word's
edges are held outside its CTC letters, 0.15 s past the last and 0.05 s before the first, never
shrinking a pause below a length the decider reads. On these recordings the aligner's start comes
before the CTC start for 99% of words, and its end after the CTC end for 99% of words before a
pause (a median 0.12 s after), so the CTC letters are a safe floor for what a cut must keep.

Developed on dev, held-out, fresh and final; scored once on the other set afterwards.

| Set | Whisper alone | with the CTC check | True transcript |
|---|---|---|---|
| dev (12) | 2, 22/22 | 0, 22/22 | 0, 22/22 |
| held-out (13) | 0, 16/16 | 0, 16/16 | 0, 16/16 |
| fresh (12) | 0, 13/13 | 0, 13/13 | 0, 13/13 |
| final (30), now a development set | 20, 36/42 | 12, 36/42 | 4, 40/42 |
| **other (33), scored once** | 48, 37/47 | **34, 38/47** | 5, 46/47 |

Word error rate falls a little (final 5.4% to 5.0%, other 10.1% to 9.7%); dead air kept rises by
at most 0.5 points of the output. Cost: 0.16-0.17 CPU s per audio second more on 2 threads (about
1 s to load the model per clip on top), 0.52 in all with Whisper on the other set; about 1 GB of
memory while it runs.

What it fixes is edges: on the other set the kept units cut at an edge fall from 19 to 12, while the
units lost whole (a wrong take kept, a kept take cut) stay at 14, and 9 retake groups still go
wrong. Those come from Whisper's punctuation and the decider: an abandoned start Whisper closes with
a full stop, a pause inside the kept take written as "give...", which no acoustic model can see.

Tried and left out, on the development sets: moving every word onto its CTC times before the edges
are refined (alone it lost a retake group on dev and on fresh; with the other parts, final 17
clipped and 34/42, dev 20/22), adding CTC words Whisper did not write (nearly
all were compounds the model splits, "TO MORROW", "POP CORN"; no folded repeat showed up as a
separate CTC copy once the unheard copies were dropped), and letting a held edge always reach the
CTC span whatever the pause (final 10 clipped, but dev 21/22). The int8 ONNX export of the same
model writes garbage and is not used.

Caveat: wav2vec2-base-960h was fine-tuned on LibriSpeech's 960 h of training speech, other speakers
but the same kind of audiobook audio as every set here. On a creator's phone in a noisy room it
will hear less, and a word it hears nothing of is dropped. The gain measured here is an upper bound.

### Whisper's punctuation and segmentation (this round)

On the other set most retake groups that went wrong with Whisper and right with the true transcript
came from how the decider read Whisper's text: an abandoned start Whisper closed with a full stop or
a question mark ("To say nothing, said Montalais." then "To say nothing, said Montalais, so that
when..."), a one-word start ("But,") whose pause Whisper's times shrank, an abandoned attempt split
over two utterances, and, with a script, a take of one line joined to the next line. The true
transcript is punctuated too, but perfectly (a full stop on every finished line, none on an
abandoned start), which is why the decider does well on it. The changes (packages/analyze/src):

| | What | Where |
|---|---|---|
| A | A sentence the next utterance says again word for word and carries on is an abandoned start, whatever its full stop | heuristic.ts `restartsOpening`, `decideByRetakes` |
| B | With a script: a take of one line is not joined to the next line as its lead-in; a reading never joins a restart of its own opening (three words said again; two are a figure of speech) | heuristic.ts `matchSpans` |
| C | A one-word start written with a comma or a break ties to its restart after a pause of 0.2 s, not 0.4 s | heuristic.ts `sameLine` |
| D | "No, no, no." is one phrase, not "No," and an aside | chunks.ts |
| E | The pieces of an abandoned attempt that the kept take says again are cut with it | heuristic.ts `decideByRetakes` |
| G | Parallel phrases that open alike but change a word ("o eternal everywhere / o eternal nowhere"; "a hat / and a coat / and my boots") are not restarts, unless the word is the longer one's words misheard or run together | heuristic.ts `parallelOpening` |
| H | "Ah" opening a sentence that runs straight on is a word, not a filler ("um", "uh", "er" always are) | text.ts `flagFillers` |

Clipped words and retake groups right; developed on dev, held-out, fresh, final and other, devother
scored once before and once after:

| Set | Whisper + CTC, before | after | True transcript, before | after |
|---|---|---|---|---|
| dev (12) | 0, 22/22 | 0, 22/22 | 0, 22/22 | 0, 22/22 |
| held-out (13) | 0, 16/16 | 0, 16/16 | 0, 16/16 | 0, 16/16 |
| fresh (12) | 0, 13/13 | 0, 13/13 | 0, 13/13 | 0, 13/13 |
| final (30) | 12, 36/42 | 6, 40/42 | 4, 40/42 | 0, 42/42 |
| other (33) | 34, 38/47 | 32, 43/47 | 5, 46/47 | 0, 47/47 |
| **devother (33), scored once** | 17, 37/47 | **17, 39/47** | 3, 45/47 | **2, 46/47** |

Leave-one-out on the development sets (dev, held-out and fresh never change): without A, final
Whisper 37/42 and other 42/47; without B, final truth 2 clipped and 40/42, other Whisper 41/47;
without C, other Whisper 42/47; without D, final Whisper 9 clipped and 39/42; without E, other
Whisper 42/47; without G, other 34 clipped (Whisper) and 3 (truth); without H, final 8 (Whisper) and
2 (truth), other truth 2 clipped and 46/47. The synthetic recordings (`npm run score`, with
`--touching` and `--jitter 0.06`), recorded, batch30, variants and broll score the same with every
change. On devother B cost two kept lines (a script line that says its own opening twice, "How can
you how can you speak of it"; a lead-in taken for the opening of a shorter line), so its guards are
tuned closer to the development sets than the others.

Tried and left out: a decider that ignores Whisper's punctuation, measured on top of A, B and C
(other then 34 clipped and 42/47). Stripping it (all of it, or only sentence ends; for the decider
only, or for snapping too) fixed a few groups the punctuation broke but lost abandoned starts
Whisper had marked right: Whisper on the other set 38-39/47 in every variant; fresh 12/13 in every
variant, held-out 15/16 with everything stripped. Fewer clipped words there (other 23-30) came
with abandoned starts kept (cut units cut 86.7-90.0% against 96.7%) or, with only sentence ends
stripped before snapping, with every pause read as inside a sentence and more dead air kept. Whisper's
punctuation is mostly right; it is wrong in recognisable ways, and those are what the rules above
read past. Also tried: holding a sentence-final word's end 0.25 s or 0.35 s past its last CTC letter
(other 30 and 32 clipped, nothing else changed): the pause rules, not the hold, limit those edges.
Not tried: a pitch or energy fall at a full stop. On these recordings an abandoned start is cut
from the full line's own audio, so its prosody at the break is that of a sentence-internal
boundary by construction, and a detector tuned on that would not say how a creator trails off.

What is left with Whisper is mostly not punctuation: of the 32 clipped words on the other set, 20
are a kept word cut at its edge where Whisper's time is off by more than the CTC hold allows (a cut
word laid over the kept take's first word, a line-final word whose release the CTC model does not
hear), and 12 are whole kept units lost to mishearing (a script line Whisper heard as other words
matches no line and is cut as off-script; a Latin line; "Ulrica" as "a good see you").

## What this proves, and what it does not

It shows how the pipeline does on real voices, real reading pauses, real room noise of varying
level, and real Whisper output (its timing error, punctuation, mishearing and hallucinations)
over 12 speakers. It does not show how it does on creators: read speech is fluent, these speakers
have no fillers, the abandoned starts are mostly cut from the same audio as the full line, the
room tone was stitched, every recording was made in a quiet room with a good microphone, and the
retake structure was designed by us, not by a person losing their place.
