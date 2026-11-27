#!/usr/bin/env node
// Writes fixtures/real/specs/*.json: which real utterances each "recording" is assembled from,
// in what order, with which retakes, pauses, levels and clip splits. Deterministic (seeded per
// speaker) and only needs the cache `fetch.py` filled. The specs are committed; rerun this only
// to change the design, then `node fixtures/real/generate.mjs` to rebuild the media.
//
// Usage: node fixtures/real/plan.mjs [--cache <dir>] [--specs <dir>]
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  if (!['--cache', '--specs'].includes(args[i]) || args[i + 1] === undefined) {
    console.error(`plan.mjs: unknown or incomplete argument "${args[i]}". Usage: [--cache <dir>] [--specs <dir>]`);
    process.exit(2);
  }
}
const argOf = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const cache = resolve(argOf('--cache') ?? join(here, '.work/cache/librispeech'));
const specDir = resolve(argOf('--specs') ?? join(here, 'specs'));

function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 1_000_000) / 1_000_000;
  };
}
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

const all = readdirSync(cache).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(cache, f), 'utf8')));
const bySpeaker = new Map();
for (const u of all) bySpeaker.set(u.speaker, [...(bySpeaker.get(u.speaker) ?? []), u]);
for (const list of bySpeaker.values()) list.sort((a, b) => a.id.localeCompare(b.id));

const dur = (u) => u.words[u.words.length - 1].end - u.words[0].start;
/** A usable line: every word aligned and named, a length a creator would say in one breath or two. */
const usable = (u) =>
  !u.words.some((w) => w.text === '<unk>') && u.words.length === u.transcript.split(' ').length && dur(u) >= 1.6 && dur(u) <= 7.5 && u.words.length >= 4;

/**
 * Where to abandon a line: after `k` words, at a real word boundary. Prefers a boundary with a
 * pause after it (a natural place to stop), near `target` words in.
 */
function abandonAt(u, target, avoid = new Set()) {
  const n = u.words.length;
  let best = null;
  for (let k = 2; k <= n - 2; k++) {
    if (avoid.has(k)) continue;
    const gap = u.words[k].start - u.words[k - 1].end;
    const score = Math.abs(k - target) - (gap >= 0.06 ? 1.5 : 0);
    if (!best || score < best.score) best = { k, score };
  }
  return best?.k ?? 2;
}

/**
 * The recordings. `special` holds retakes made of two different real readings by the same
 * speaker (LibriSpeech has a few sentences a reader says twice, or that open the same way).
 */
const RECORDINGS = [
  { id: 'real_174', speaker: '174', lines: 5, clips: 2, script: true, special: [{ attempts: ['174-50561-0012', '174-50561-0009'], full: '174-50561-0003', why: 'the reader says "the wandering singer" on its own twice, then the full sentence' }] },
  { id: 'real_3081', speaker: '3081', lines: 8, clips: 1, script: false, special: [{ attempts: [['3081-166546-0006', 6]], full: '3081-166546-0011', why: 'two different sentences that open with the same six words: the first six words of one, then the other' }] },
  { id: 'real_777', speaker: '777', lines: 6, clips: 2, script: false, special: [{ attempts: [['777-126732-0025', 6]], full: '777-126732-0003', why: 'two sentences that open "michaelis the ticket of leave apostle": that opening from one, then the other in full' }] },
  { id: 'real_1462', speaker: '1462', lines: 8, clips: 1, script: true },
  { id: 'real_2277', speaker: '2277', lines: 8, clips: 3, script: false },
  { id: 'real_6313', speaker: '6313', lines: 9, clips: 1, script: false, fps: 60 },
  { id: 'real_2035', speaker: '2035', lines: 7, clips: 2, script: true, size: '1280x720' },
  { id: 'real_251', speaker: '251', lines: 9, clips: 1, script: false },
  { id: 'real_3752', speaker: '3752', lines: 8, clips: 2, script: true, fps: 60 },
  { id: 'real_7976', speaker: '7976', lines: 7, clips: 1, script: false },
  { id: 'real_2428', speaker: '2428', lines: 8, clips: 2, script: false },
  { id: 'real_1272', speaker: '1272', lines: 7, clips: 1, script: true },
];

/** Retake designs, used in turn: one abandoned start; two abandoned starts; a start left at the end of a clip. */
const KINDS = ['abandon', 'abandon2', 'abandon', 'clip_restart', 'abandon2'];

mkdirSync(specDir, { recursive: true });
let kindTurn = 0;
for (const rec of RECORDINGS) {
  const r = rng(Number(rec.speaker) * 7919 + 17);
  const specialIds = new Set((rec.special ?? []).flatMap((s) => [s.full, ...s.attempts.map((a) => (Array.isArray(a) ? a[0] : a))]));
  // One chapter per recording, as one recording session: the room tone stays the room's. The
  // chapter of the special retakes if there are any, else the one with the most usable lines.
  const usableAll = bySpeaker.get(rec.speaker).filter((u) => usable(u) && !specialIds.has(u.id));
  const chapters = new Map();
  for (const u of usableAll) chapters.set(u.chapter, (chapters.get(u.chapter) ?? 0) + 1);
  const specialChapter = [...specialIds][0]?.split('-')[1];
  const chapter = specialChapter ?? [...chapters.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const inChapter = usableAll.filter((u) => u.chapter === chapter);
  const pool = inChapter.length >= rec.lines - (rec.special?.length ?? 0) ? inChapter : usableAll;
  // A run of consecutive lines from one chapter reads like one piece of content.
  const start = Math.floor(r() * Math.max(1, pool.length - rec.lines));
  const lines = pool.slice(start, start + rec.lines - (rec.special?.length ?? 0));
  const special = (rec.special ?? []).map((s) => ({ ...s, at: 1 + Math.floor(r() * Math.max(1, lines.length - 1)) }));

  // Each line, with its retake design: two or three plain lines, then one with retakes.
  const items = [];
  let sinceRetake = 0;
  lines.forEach((u, i) => {
    for (const s of special.filter((x) => x.at === i)) items.push({ special: s });
    const wantRetake = sinceRetake >= 2 && r() < 0.6 && i < lines.length - 1;
    items.push({ u, kind: wantRetake ? KINDS[kindTurn++ % KINDS.length] : 'plain' });
    sinceRetake = wantRetake ? 0 : sinceRetake + 1;
  });

  // Clip splits: evenly by item count; a clip_restart retake must straddle a split.
  const nClips = rec.clips;
  const per = Math.ceil(items.length / nClips);
  const clipOf = items.map((_, i) => Math.min(nClips - 1, Math.floor(i / per)));
  const pause = (kind) => {
    const x = r();
    if (kind === 'retry') return round(0.4 + x * 1.2); // the beat before trying a line again
    if (x < 0.55) return round(0.25 + r() * 0.45); // a natural gap between lines
    if (x < 0.85) return round(0.8 + r() * 1.7); // thinking, reading the next line
    return round(2.5 + r() * 3); // looking at notes, resetting
  };
  const clips = Array.from({ length: nClips }, (_, c) => ({
    name: nClips === 1 ? 'take' : `part${c + 1}`,
    fps: rec.fps ?? 30,
    size: rec.size ?? '720x1280',
    // Level differences: each clip at its own level, as phones at different distances.
    gainDb: c === 0 ? 0 : round(-7 + r() * 9, 1),
    leadIn: round(0.3 + r() * 1.2),
    tail: round(0.5 + r() * 1.5),
    pieces: [],
  }));
  const jitter = () => round((r() - 0.5) * 3, 1); // take-to-take level change, dB
  let group = 0;
  items.forEach((it, i) => {
    let c = clips[clipOf[i]];
    const prevSameClip = i > 0 && clipOf[i - 1] === clipOf[i];
    if (prevSameClip) c.pieces.push({ pause: pause('line') });
    if (it.special) {
      const g = `g${++group}`;
      for (const a of it.special.attempts) {
        const [utt, k] = Array.isArray(a) ? a : [a, undefined];
        c.pieces.push({ utt, ...(k ? { words: k } : {}), role: 'abandoned', group: g, gainDb: jitter() });
        c.pieces.push({ pause: pause('retry') });
      }
      c.pieces.push({ utt: it.special.full, role: 'line', group: g, gainDb: jitter(), note: it.special.why });
      return;
    }
    const u = it.u;
    const n = u.words.length;
    if (it.kind === 'plain') {
      c.pieces.push({ utt: u.id, role: 'line', gainDb: jitter() });
      return;
    }
    const g = `g${++group}`;
    if (it.kind === 'abandon' || it.kind === 'clip_restart') {
      const k = abandonAt(u, Math.max(2, Math.round(n * (0.3 + r() * 0.3))));
      c.pieces.push({ utt: u.id, words: k, role: 'abandoned', group: g, gainDb: jitter() });
      if (it.kind === 'clip_restart' && clipOf[i] < nClips - 1) {
        // The creator stops recording mid-line and starts the next clip with the whole line.
        c = clips[clipOf[i] + 1];
        c.pieces.unshift({ utt: u.id, role: 'line', group: g, gainDb: jitter() }, { pause: pause('line') });
        return;
      }
      c.pieces.push({ pause: pause('retry') });
    } else {
      const k1 = abandonAt(u, Math.max(2, Math.round(n * 0.25)));
      const k2 = abandonAt(u, Math.max(k1 + 1, Math.round(n * 0.6)), new Set(Array.from({ length: k1 }, (_, j) => j + 1)));
      c.pieces.push({ utt: u.id, words: k1, role: 'abandoned', group: g, gainDb: jitter() });
      c.pieces.push({ pause: pause('retry') });
      c.pieces.push({ utt: u.id, words: Math.max(k2, k1 + 1), role: 'abandoned', group: g, gainDb: jitter() });
      c.pieces.push({ pause: pause('retry') });
    }
    c.pieces.push({ utt: u.id, role: 'line', group: g, gainDb: jitter() });
  });
  // A clip_restart can leave a pause first in the next clip; drop leading and doubled pauses.
  for (const c of clips) {
    while (c.pieces[0]?.pause !== undefined) c.pieces.shift();
    while (c.pieces.at(-1)?.pause !== undefined) c.pieces.pop();
    c.pieces = c.pieces.filter((p, j, a) => !(p.pause !== undefined && a[j + 1]?.pause !== undefined));
  }
  const spec = {
    id: rec.id,
    title: `Real speech, LibriSpeech speaker ${rec.speaker} (${bySpeaker.get(rec.speaker)[0].sex})`,
    mode: 'general',
    speaker: rec.speaker,
    script: rec.script,
    clips: clips.filter((c) => c.pieces.length),
  };
  writeFileSync(join(specDir, `${rec.id}.json`), JSON.stringify(spec, null, 2) + '\n');
  const groups = new Set(spec.clips.flatMap((c) => c.pieces.map((p) => p.group).filter(Boolean)));
  console.log(`${rec.id}: ${spec.clips.length} clip(s), ${spec.clips.reduce((n, c) => n + c.pieces.filter((p) => p.role === 'line').length, 0)} lines, ${groups.size} retake group(s)`);
}
