#!/usr/bin/env node
// Assembles "recordings" from real read speech (LibriSpeech dev-clean, or test-clean for the final
// set; CC BY 4.0) with known
// right answers. Needs ffmpeg and the cache `fetch.py` fills. These are NOT creator
// recordings: see README.md for what they are and are not.
//
// Usage: node fixtures/real/generate.mjs [--only <id>] [--out <dir>] [--specs <dir>] [--cache <dir>]
// Any other argument is refused, so a typo cannot rebuild everything.
//
// For each spec in fixtures/real/specs/*.json this writes, under fixtures/real/.work/out/<id>/
// (gitignored), in the format fixtures/generate.mjs uses and the scorer reads:
//   <clip>.mp4          the recording: a plain coloured frame, AAC audio at 48 kHz
//   <clip>.words.json   ground-truth transcript (Montreal Forced Aligner word times, moved to the clip)
//   manifest.json       clips, units with keep/cut truth and retake groups, script, sources
// Each mp4 carries its ground-truth transcript in the `comment` tag ("kilo-words:<base64>"),
// so the `fixture` transcriber can stand in for a perfect speech-to-text when scoring.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const FLAGS = ['--only', '--out', '--specs', '--cache'];
for (let i = 0; i < args.length; i += 2) {
  if (!FLAGS.includes(args[i]) || args[i + 1] === undefined) {
    console.error(`generate.mjs: unknown or incomplete argument "${args[i]}". Usage: [--only <id>] [--out <dir>] [--specs <dir>] [--cache <dir>]`);
    process.exit(2);
  }
}
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const outRoot = resolve(argOf('--out') ?? join(here, '.work/out'));
const specDir = resolve(argOf('--specs') ?? join(here, 'specs'));
const cache = resolve(argOf('--cache') ?? join(here, '.work/cache/librispeech'));
const only = argOf('--only');

const SR = 16000; // LibriSpeech's rate; the MP4 carries it resampled to 48 kHz
/** Inside one line, a pause at least this long splits the line into two scored units. */
export const UNIT_SPLIT_GAP = 0.1;
/** Room tone kept around a line from its own recording, at most. */
const LEAD = 0.3;
const TAIL = 0.3;
const XFADE = 0.015;
const run = (cmd, a, input) => execFileSync(cmd, a, { input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], maxBuffer: 1 << 30 });
const round = (n) => Math.round(n * 1000) / 1000;

function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 1_000_000) / 1_000_000;
  };
}

// ---- source audio ------------------------------------------------------------------

const metaCache = new Map();
function utterance(id) {
  if (!metaCache.has(id)) {
    const meta = JSON.parse(readFileSync(join(cache, `${id}.json`), 'utf8'));
    const pcm = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', join(cache, `${id}.flac`), '-f', 's16le', '-ac', '1', '-ar', String(SR), '-']);
    const i16 = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
    const samples = Float32Array.from(i16, (v) => v / 32768);
    const tokens = meta.transcript.split(' ');
    // MFA writes <unk> for words outside its dictionary; the transcript has the word itself.
    const words = meta.words.map((w, i) => ({ ...w, text: w.text === '<unk>' && tokens.length === meta.words.length ? tokens[i] : w.text }));
    metaCache.set(id, { ...meta, words, samples, durationSec: samples.length / SR });
  }
  return metaCache.get(id);
}

const rmsDb = (x, a, b) => {
  let s = 0;
  const n = Math.max(1, b - a);
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return 10 * Math.log10(s / n + 1e-12);
};

/**
 * The speaker's room tone: the quiet stretches of their own recordings (before the first
 * word, after the last, and long pauses between words), minus anything with a breath or click
 * and minus processed near-digital silence.
 */
function roomTone(speaker) {
  const ids = readdirSync(cache).filter((f) => f.startsWith(`${speaker}-`) && f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  const regions = [];
  for (const id of ids) {
    const u = utterance(id);
    const spans = [[0.02, u.words[0].start - 0.06]];
    for (let i = 1; i < u.words.length; i++) if (u.words[i].start - u.words[i - 1].end > 0.25) spans.push([u.words[i - 1].end + 0.06, u.words[i].start - 0.06]);
    spans.push([u.words[u.words.length - 1].end + 0.08, u.durationSec - 0.02]);
    for (const [a, b] of spans) if (b - a >= 0.12) regions.push({ u, a: Math.round(a * SR), b: Math.round(b * SR) });
  }
  // Level of every 20 ms window: a region is clean when no window stands out from its median.
  const win = SR / 50;
  for (const r of regions) {
    const levels = [];
    for (let i = r.a; i + win <= r.b; i += win) levels.push(rmsDb(r.u.samples, i, i + win));
    levels.sort((x, y) => x - y);
    r.level = levels[Math.floor(levels.length / 2)] ?? -120;
    r.peak = levels[levels.length - 1] ?? -120;
  }
  const clean = regions.filter((r) => r.peak <= r.level + 6 && r.level > -78);
  if (!clean.length) throw new Error(`speaker ${speaker}: no clean room tone`);
  const sorted = clean.map((r) => r.level).sort((x, y) => x - y);
  return { floorDb: sorted[Math.floor(sorted.length / 2)], regions: clean };
}

/** The room tone level of one utterance: the median level of its own quiet stretches. */
function toneLevelOf(tone, id) {
  const own = tone.regions.filter((r) => r.u.id === id).map((r) => r.level).sort((x, y) => x - y);
  return own.length ? own[Math.floor(own.length / 2)] : tone.floorDb;
}

/**
 * `sec` of room tone to sit next to utterance `near`, joined with short crossfades: its own
 * quiet stretches when it has enough, else stretches of the speaker's other recordings at the
 * same level (within 3 dB), so a pause sounds like the room the line was read in.
 */
function toneOf(tone, sec, r, near) {
  const own = tone.regions.filter((x) => x.u.id === near);
  const ownLen = own.reduce((n, x) => n + x.b - x.a, 0) / SR;
  const level = toneLevelOf(tone, near);
  let pool = ownLen >= 0.3 ? own : tone.regions.filter((x) => Math.abs(x.level - level) <= 3);
  if (!pool.length) pool = tone.regions;
  const need = Math.max(1, Math.round(sec * SR));
  const out = new Float32Array(need);
  const xf = Math.round(0.02 * SR);
  let pos = 0;
  while (pos < need) {
    const reg = pool[Math.floor(r() * pool.length)];
    const len = Math.min(reg.b - reg.a, need - pos + xf);
    for (let i = 0; i < len && pos + i < need; i++) {
      const v = reg.u.samples[reg.a + i];
      if (pos > 0 && i < xf) {
        const w = i / xf;
        out[pos + i] = out[pos + i] * (1 - w) + v * w;
      } else out[pos + i] = v;
    }
    pos += Math.max(1, len - xf);
  }
  return out;
}

// ---- assembly ----------------------------------------------------------------------

/** Appends `seg` to the clip with a crossfade of `xf` samples; returns where seg's sample 0 landed. */
function append(buf, seg, xf) {
  const at = Math.max(0, buf.len - xf);
  for (let i = 0; i < seg.length; i++) {
    const j = at + i;
    if (j < buf.len) {
      const w = (j - at + 1) / (xf + 1);
      buf.data[j] = buf.data[j] * (1 - w) + seg[i] * w;
    } else buf.data[j] = seg[i];
  }
  buf.len = Math.max(buf.len, at + seg.length);
  return at;
}

const sentence = (texts) =>
  texts.map((t, i) => {
    let s = t === 'i' || t.startsWith("i'") ? 'I' + t.slice(1) : t;
    if (i === 0) s = s[0].toUpperCase() + s.slice(1);
    return s;
  });

function buildClip(spec, clip, order, dir, tone, r, lineIndex) {
  const maxSec = 600;
  const buf = { data: new Float32Array(maxSec * SR), len: 0 };
  const gain = (db) => 10 ** (db / 20);
  const clipGain = clip.gainDb ?? 0;
  const pieces = [];
  let toneTail = Infinity; // room tone available at the end of what is placed so far, samples
  const placeTone = (sec, db, near) => {
    const seg = toneOf(tone, sec + 2 * XFADE, r, near).map((v) => v * gain(db));
    append(buf, seg, Math.min(Math.round(XFADE * SR), toneTail));
    toneTail = seg.length;
  };
  const firstUtt = clip.pieces.find((p) => p.utt)?.utt;
  placeTone(clip.leadIn ?? 0.5, clipGain + (clip.pieces.find((p) => p.utt)?.gainDb ?? 0), firstUtt);
  let lastDb = clipGain;
  let lastUtt = firstUtt;
  for (const p of clip.pieces) {
    if (p.pause !== undefined) {
      placeTone(p.pause, lastDb, lastUtt);
      continue;
    }
    const u = utterance(p.utt);
    const n = p.words ?? u.words.length;
    const words = u.words.slice(0, n);
    const first = words[0];
    const last = words[n - 1];
    const lead = Math.min(LEAD, first.start);
    // A line said in full keeps its own trailing room tone; an abandoned one stops at the end of
    // its last word, with at most the pause that followed that word in the reading.
    const after = n < u.words.length ? u.words[n].start - last.end : u.durationSec - last.end;
    const hardStop = n < u.words.length && after < 0.012;
    const tail = hardStop ? 0.008 : Math.min(TAIL, Math.max(0, after - 0.004));
    const a = Math.round((first.start - lead) * SR);
    const b = Math.min(u.samples.length, Math.round((last.end + tail) * SR));
    const db = clipGain + (p.gainDb ?? 0);
    const seg = u.samples.slice(a, b).map((v) => v * gain(db));
    // Short fades at the edges; the stop of an abandoned line fades over the next word's first 8 ms.
    const fin = Math.min(Math.round(0.005 * SR), Math.round(lead * SR));
    for (let i = 0; i < fin; i++) seg[i] *= i / fin;
    const fout = hardStop ? Math.round(0.008 * SR) : Math.min(Math.round(0.005 * SR), Math.round(tail * SR));
    for (let i = 0; i < fout; i++) seg[seg.length - 1 - i] *= i / fout;
    const xf = Math.max(1, Math.min(Math.round(XFADE * SR), Math.round(lead * SR) - 1, toneTail));
    const at = append(buf, seg, xf);
    toneTail = Math.round(tail * SR);
    const shift = at / SR - first.start + lead;
    const complete = n === u.words.length;
    const texts = sentence(words.map((w) => w.text));
    if (complete) texts[texts.length - 1] += '.';
    pieces.push({
      p,
      complete,
      words: words.map((w, i) => ({ text: texts[i], start: round(w.start + shift), end: round(w.end + shift) })),
      gainDb: round(db),
      source: { utt: u.id, from: round(first.start - lead), to: round(last.end + tail) },
    });
    lastDb = db;
    lastUtt = p.utt;
  }
  placeTone(clip.tail ?? 0.6, lastDb, lastUtt);
  let data = buf.data.subarray(0, buf.len);
  // Never clip: scale the whole clip down if a loud take would.
  let peak = 0;
  for (const v of data) peak = Math.max(peak, Math.abs(v));
  if (peak > 0.97) data = data.map((v) => (v * 0.97) / peak);
  const durationSec = round(data.length / SR);

  // Ground truth: words, and units (a line, or the parts of a line between pauses).
  const units = [];
  const words = [];
  let prevEnd = null;
  for (const pc of pieces) {
    const keep = pc.p.role === 'line' && !pc.p.cut;
    const reason = keep ? 'speech' : pc.complete ? 'retake' : 'false_start';
    if (prevEnd !== null && pc.words[0].start - prevEnd >= 0.3) {
      units.push({ index: units.length, kind: 'pause', start: prevEnd, end: pc.words[0].start, keep: false, reason: 'dead_air', text: '' });
    }
    let cur = [];
    const flush = () => {
      if (!cur.length) return;
      units.push({
        index: units.length,
        kind: 'speech',
        start: cur[0].start,
        end: cur[cur.length - 1].end,
        keep,
        reason,
        text: cur.map((w) => w.text).join(' '),
        ...(lineIndex.has(pc.p.utt) ? { line: lineIndex.get(pc.p.utt) } : {}),
        ...(pc.p.group ? { group: pc.p.group } : {}),
        source: pc.source.utt,
      });
      cur = [];
    };
    for (const w of pc.words) {
      const prev = cur[cur.length - 1];
      if (prev && w.start - prev.end >= UNIT_SPLIT_GAP) flush();
      cur.push(w);
      words.push({ text: w.text, start: w.start, end: w.end, confidence: 1, filler: false });
    }
    flush();
    prevEnd = pc.words[pc.words.length - 1].end;
  }

  const wav = join(dir, `.${clip.name}.wav`);
  const pcm = Buffer.alloc(data.length * 2);
  for (let i = 0; i < data.length; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(data[i] * 32767))), i * 2);
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 's16le', '-ar', String(SR), '-ac', '1', '-i', '-', wav], pcm);
  const transcript = { clipId: clip.name, language: 'en', durationSec, words };
  const tag = 'kilo-words:' + Buffer.from(JSON.stringify(transcript)).toString('base64');
  const [w, h] = (clip.size ?? '720x1280').split('x').map(Number);
  const fps = clip.fps ?? 30;
  const bg = ['0x2B3038', '0x3A2B38', '0x2B3830'][order % 3];
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-threads', '2',
    '-f', 'lavfi', '-t', String(durationSec), '-i', `color=c=${bg}:s=${w}x${h}:r=${fps}`,
    '-i', wav,
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-crf', '30', '-pix_fmt', 'yuv420p',
    '-af', 'aresample=48000:resampler=soxr', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
    '-t', String(durationSec), '-movflags', '+faststart', '-metadata', `comment=${tag}`,
    join(dir, `${clip.name}.mp4`),
  ]);
  rmSync(wav, { force: true });
  writeFileSync(join(dir, `${clip.name}.words.json`), JSON.stringify(transcript, null, 2));
  return {
    name: clip.name,
    file: `${clip.name}.mp4`,
    wordsFile: `${clip.name}.words.json`,
    order,
    durationSec,
    fps,
    width: w,
    height: h,
    units,
    pieces: pieces.map((pc) => ({ role: pc.p.role, group: pc.p.group, gainDb: pc.gainDb, start: pc.words[0].start, end: pc.words[pc.words.length - 1].end, ...pc.source, ...(pc.p.note ? { note: pc.p.note } : {}) })),
    roomToneFloorDb: round(tone.floorDb + clipGain),
  };
}

for (const name of readdirSync(specDir).filter((f) => f.endsWith('.json')).sort()) {
  const spec = JSON.parse(readFileSync(join(specDir, name), 'utf8'));
  if (only && spec.id !== only) continue;
  const dir = join(outRoot, spec.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tone = roomTone(spec.speaker);
  const r = rng(Number(spec.speaker) + 101);
  // Script lines: every line said in full, in the order its kept take is heard.
  const lineIndex = new Map();
  for (const c of spec.clips) for (const p of c.pieces) if (p.role === 'line' && !lineIndex.has(p.utt)) lineIndex.set(p.utt, lineIndex.size);
  const clips = spec.clips.map((c, i) => buildClip(spec, c, i, dir, tone, r, lineIndex));
  const script = spec.script
    ? [...lineIndex.keys()].map((id) => sentence(utterance(id).words.map((w) => w.text)).join(' ') + '.')
    : null;
  const manifest = {
    id: spec.id,
    title: spec.title,
    mode: spec.mode ?? 'general',
    script,
    clips,
    broll: [],
    source: `Assembled from LibriSpeech ${/LibriSpeech (\S+)/.exec(utterance([...lineIndex.keys()][0]).source ?? '')?.[1] ?? 'dev-clean'} read speech (CC BY 4.0) with MFA word alignments; not a creator recording. See fixtures/real/README.md.`,
    speaker: spec.speaker,
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const total = clips.reduce((n, c) => n + c.durationSec, 0);
  const groups = new Set(clips.flatMap((c) => c.units.map((u) => u.group).filter(Boolean)));
  console.log(`${spec.id}: ${clips.length} clip(s), ${round(total)}s, ${groups.size} retake group(s) -> ${dir}`);
}
