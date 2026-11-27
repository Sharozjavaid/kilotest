#!/usr/bin/env node
// Checks the ground truth without listening: is there speech energy just outside a unit's
// aligned start or end (the aligner put the boundary inside the sound), and is the unit's
// own edge louder than the room tone (the boundary is not out in the silence)?
//
// Usage: node fixtures/real/check.mjs [--out <dir>] [--window <sec>]
// Reads the MP4s back as the pipeline would (16 kHz mono), so encoding is included.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  if (!['--out', '--window'].includes(args[i]) || args[i + 1] === undefined) {
    console.error(`check.mjs: unknown or incomplete argument "${args[i]}". Usage: [--out <dir>] [--window <sec>]`);
    process.exit(2);
  }
}
const argOf = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const outRoot = resolve(argOf('--out') ?? join(here, '.work/out'));
const WIN = Number(argOf('--window') ?? 0.04);
const SR = 16000;

function pcmOf(file) {
  const b = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 's16le', '-ac', '1', '-ar', String(SR), '-'], { maxBuffer: 1 << 30 });
  return new Int16Array(b.buffer, b.byteOffset, b.length / 2);
}
function db(x, t0, t1) {
  const a = Math.max(0, Math.round(t0 * SR));
  const b = Math.min(x.length, Math.round(t1 * SR));
  let s = 0;
  for (let i = a; i < b; i++) s += (x[i] / 32768) ** 2;
  return 10 * Math.log10(s / Math.max(1, b - a) + 1e-12);
}
/** Normalised autocorrelation peak for pitch 70-400 Hz over a 30 ms frame: voiced speech is high (> 0.5), breath and noise low. */
function voicing(x, t) {
  const a = Math.round(t * SR);
  const n = Math.round(0.03 * SR);
  if (a < 0 || a + n + SR / 70 > x.length) return 0;
  let e0 = 0;
  for (let i = 0; i < n; i++) e0 += x[a + i] ** 2;
  let best = 0;
  for (let lag = Math.round(SR / 400); lag <= Math.round(SR / 70); lag++) {
    let c = 0;
    let e1 = 0;
    for (let i = 0; i < n; i++) {
      c += x[a + i] * x[a + i + lag];
      e1 += x[a + i + lag] ** 2;
    }
    best = Math.max(best, c / Math.sqrt(e0 * e1 + 1e-9));
  }
  return best;
}
function floorOf(x) {
  const levels = [];
  for (let i = 0; i + 320 <= x.length; i += 320) levels.push(db(x, i / SR, (i + 320) / SR));
  levels.sort((a, b) => a - b);
  return levels[Math.floor(levels.length * 0.1)];
}

const rows = { start: [], end: [] };
const flagged = [];
const voiced = [];
for (const id of readdirSync(outRoot).sort()) {
  const mpath = join(outRoot, id, 'manifest.json');
  if (!existsSync(mpath)) continue;
  const m = JSON.parse(readFileSync(mpath, 'utf8'));
  for (const c of m.clips) {
    const x = pcmOf(join(outRoot, id, c.file));
    const floor = floorOf(x);
    const units = c.units.filter((u) => u.kind === 'speech');
    // The level of 10 ms frames from 10 ms to WIN + 10 ms outside each edge (the first 10 ms is
    // skipped: an abandoned line stops with an 8 ms fade). A frame over room tone by 12 dB or
    // more is sound; two such frames (20 ms) outside an edge flag it.
    const frames = (t0, dir) => Array.from({ length: Math.round(WIN / 0.01) }, (_, k) => {
      const a = dir > 0 ? t0 + 0.01 + k * 0.01 : t0 - 0.02 - k * 0.01;
      return db(x, a, a + 0.01) - floor;
    });
    for (const u of units) {
      const before = frames(u.start, -1);
      const after = frames(u.end, +1);
      const loud = (fs) => fs.filter((v) => v >= 12).length;
      // Voiced sound (a vowel or nasal) outside the edge is speech the aligner left out.
      const voicedOut = (t0, dir) => [0.01, 0.025].some((d) => {
        const at = dir > 0 ? t0 + d : t0 - d - 0.03;
        return voicing(x, at) > 0.6 && db(x, at, at + 0.03) - floor >= 12;
      });
      if (voicedOut(u.end, 1)) voiced.push(`${id}/${c.name} end ${u.end.toFixed(2)} "${u.text.slice(-30)}"`);
      if (voicedOut(u.start, -1)) voiced.push(`${id}/${c.name} start ${u.start.toFixed(2)} "${u.text.slice(0, 30)}"`);
      rows.start.push({ out: Math.max(...before), in: db(x, u.start, u.start + WIN) - floor, loud: loud(before) });
      rows.end.push({ out: Math.max(...after), in: db(x, u.end - WIN, u.end) - floor, loud: loud(after) });
      if (loud(after) >= 2 || loud(before) >= 2) {
        flagged.push(`${id}/${c.name} ${u.start.toFixed(2)}-${u.end.toFixed(2)} "${u.text.slice(0, 40)}": ${loud(before)} loud frames before, ${loud(after)} after`);
      }
    }
  }
}
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
for (const side of ['start', 'end']) {
  const out = rows[side].map((r) => r.out);
  const inn = rows[side].map((r) => r.in);
  console.log(
    `${side}: ${out.length} unit edges. Loudest 10 ms frame within ${WIN * 1000} ms outside the edge, over room tone: median ${pct(out, 0.5).toFixed(1)} dB, ` +
      `90th pct ${pct(out, 0.9).toFixed(1)} dB; edges with >= 20 ms of sound (>= 12 dB) outside: ${rows[side].filter((r) => r.loud >= 2).length}. ` +
      `${WIN * 1000} ms inside: median ${pct(inn, 0.5).toFixed(1)} dB, 10th pct ${pct(inn, 0.1).toFixed(1)} dB.`,
  );
}
if (flagged.length) console.log(`\nEdges with sound just outside (two or more 10 ms frames >= 12 dB over room tone):\n  ${flagged.join('\n  ')}`);
console.log(`\nEdges with voiced sound (periodicity > 0.6, >= 12 dB over room tone) within 10-55 ms outside: ${voiced.length} of ${rows.start.length + rows.end.length}`);
if (voiced.length) console.log(`  ${voiced.join('\n  ')}`);
