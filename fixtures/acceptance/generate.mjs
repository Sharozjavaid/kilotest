#!/usr/bin/env node
// Builds the acceptance recordings. Needs ffmpeg and espeak-ng.
//
//   node fixtures/acceptance/generate.mjs [--specs <dir>] [--out <dir>] [--only <id>] [--force]
//
// Defaults: specs from fixtures/specs/acceptance/ (searched recursively), output to
// fixtures/acceptance/out/ (gitignored). It never reads fixtures/specs/*.json and
// never writes to fixtures/out/, so the Phase 0 fixtures and `npm run score` are
// untouched. A fixture is rebuilt only when its spec or this file is newer than its
// manifest (or with --force).
//
// Two kinds of spec:
//
// 1. A fixture spec ({ id, clips: [...] }), the same format as fixtures/specs/*.json,
//    plus `touch: true` on a unit: the next unit follows with no pause at all.
//
// 2. A performance spec ({ id, script, takes: [...] }): one performance written once and
//    generated in two forms with identical speech audio and identical ground truth:
//      <id>-rec  as the in-app recorder sends it: one clip per take, with
//                scriptLineIndex and takeNumber, and the script in the manifest;
//      <id>-up   as an upload: the same takes played back to back as continuous
//                footage (split into several clips at `upload.splitBefore` take
//                indices), with no script and no take information.
//    A take is { line, units, leadIn?, tail?, before? }. In a take, a `say` unit is a
//    reading of the take's line unless it has `aside: true` (off-script talk). Readings
//    are cut unless `keep: true`; a cut reading needs `reason` ('retake' or
//    'false_start'). Every script line must have kept readings in exactly one take.
//    `before` is the dead air before the take in the upload form (default 1.2 s);
//    `leadIn`/`tail` are the silences at the start and end of a recorded take clip.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const self = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const specRoot = resolve(argOf('--specs') ?? join(repo, 'fixtures/specs/acceptance'));
const outRoot = resolve(argOf('--out') ?? join(here, 'out'));
const only = argOf('--only');
const force = args.includes('--force');
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const GAP = 0.14; // natural gap between consecutive spoken units, as in fixtures/generate.mjs
const SR = 48000;

const run = (cmd, a) => execFileSync(cmd, a, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).toString();
const ff = (a) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-threads', '2', ...a]);
const durationOf = (p) =>
  parseFloat(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p]));
const round = (n) => Math.round(n * 1000) / 1000;

/** espeak-ng audio for a phrase, cached by text so both forms of a performance share it. */
function speak(text, cacheDir) {
  mkdirSync(cacheDir, { recursive: true });
  const name = Buffer.from(text).toString('base64url').slice(0, 120) + `-${text.length}`;
  const wavOut = join(cacheDir, `${name}.wav`);
  if (!existsSync(wavOut)) {
    const raw = join(cacheDir, `${name}.raw.wav`);
    run('espeak-ng', ['-v', 'en-us', '-s', '160', '-w', raw, text]);
    const trim = 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.01';
    ff(['-i', raw, '-af', `${trim},areverse,${trim},areverse,aresample=${SR}`, '-ac', '1', `${wavOut}.part.wav`]);
    execFileSync('mv', [`${wavOut}.part.wav`, wavOut]);
    rmSync(raw, { force: true });
  }
  return { wav: wavOut, dur: durationOf(wavOut) };
}

function buildClip(clip, clipIndex, dir, voiceCache) {
  const tmp = join(dir, '.work', clip.name);
  mkdirSync(tmp, { recursive: true });
  const parts = [];
  const units = [];
  const words = [];
  let t = clip.leadIn ?? 0.4;
  parts.push({ silence: t });
  clip.units.forEach((u, i) => {
    if (u.pause !== undefined) {
      units.push({ index: i, kind: 'pause', start: round(t), end: round(t + u.pause), keep: false, reason: 'dead_air', text: '' });
      parts.push({ silence: u.pause });
      t += u.pause;
      return;
    }
    const text = u.say ?? u.filler;
    const { wav, dur } = speak(text, voiceCache);
    const kind = u.filler ? 'filler' : 'speech';
    const keep = u.filler ? false : u.keep !== false;
    const reason = u.filler ? 'filler' : keep ? 'speech' : (u.reason ?? 'retake');
    units.push({
      index: i, kind, start: round(t), end: round(t + dur), keep, reason, text,
      ...(u.line !== undefined ? { line: u.line } : {}),
      ...(u.group !== undefined ? { group: u.group } : {}),
      ...(u.take !== undefined ? { take: u.take } : {}),
      ...(u.aside ? { aside: true } : {}),
    });
    const tokens = text.split(/\s+/).filter(Boolean);
    const total = tokens.reduce((n, w) => n + w.length, 0);
    let wt = t;
    for (const tok of tokens) {
      const wd = (dur * tok.length) / total;
      words.push({ text: tok, start: round(wt), end: round(wt + wd), confidence: 1, filler: Boolean(u.filler) });
      wt += wd;
    }
    parts.push({ file: wav, dur });
    t += dur;
    const next = clip.units[i + 1];
    if (next && next.pause === undefined && !u.touch) {
      parts.push({ silence: GAP });
      t += GAP;
    }
  });
  const tail = clip.tail ?? 0.5;
  parts.push({ silence: tail });
  t += tail;
  const durationSec = round(t);

  const inputs = [];
  const labels = [];
  parts.forEach((p, i) => {
    if (p.file) inputs.push('-i', p.file);
    else inputs.push('-f', 'lavfi', '-t', String(p.silence), '-i', `anullsrc=r=${SR}:cl=mono`);
    labels.push(`[${i}:a]`);
  });
  const audio = join(tmp, 'audio.wav');
  ff([
    ...inputs,
    '-f', 'lavfi', '-t', String(durationSec), '-i', `anoisesrc=r=${SR}:c=pink:a=0.004:seed=${7 + clipIndex}`,
    '-filter_complex',
    `${labels.join('')}concat=n=${parts.length}:v=0:a=1[s];[s][${parts.length}:a]amix=inputs=2:duration=first:normalize=0[a]`,
    '-map', '[a]', '-ac', '1', '-ar', String(SR), audio,
  ]);

  // Picture: a flat card with a band that is blue over kept speech and red over cut
  // speech, so a rendered frame shows whether it came from kept content.
  const [w, h] = (clip.size ?? '360x640').split('x').map(Number);
  const fps = clip.fps ?? 30;
  const draws = units.map(
    (u) => `drawbox=x=0:y=ih*0.62:w=iw:h=ih*0.26:color=${u.keep ? '0x1F5EFF' : '0xB4441E'}@1:t=fill:enable='between(t,${u.start},${u.end})'`,
  );
  const bg = clip.background ?? ['0x2B3038', '0x3A2B38', '0x2B3830'][clipIndex % 3];
  const transcript = { clipId: clip.name, language: 'en', durationSec, words };
  const tag = 'kilo-words:' + Buffer.from(JSON.stringify(transcript)).toString('base64');
  const mp4 = join(dir, `${clip.name}.mp4`);
  const label = `drawtext=fontfile=${FONT}:text='${clip.name} %{pts\\:hms}':fontsize=${Math.round(w / 18)}:fontcolor=white@0.8:x=12:y=12`;
  ff([
    '-f', 'lavfi', '-t', String(durationSec), '-i', `color=c=${bg}:s=${w}x${h}:r=${fps}`,
    '-i', audio,
    '-vf', [label, ...draws].join(','),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart',
    '-metadata', `comment=${tag}`, mp4,
  ]);
  writeFileSync(join(dir, `${clip.name}.words.json`), JSON.stringify(transcript, null, 2));
  return {
    name: clip.name,
    file: `${clip.name}.mp4`,
    wordsFile: `${clip.name}.words.json`,
    order: clipIndex,
    durationSec,
    fps,
    width: w,
    height: h,
    ...(clip.scriptLineIndex !== undefined ? { scriptLineIndex: clip.scriptLineIndex } : {}),
    ...(clip.takeNumber !== undefined ? { takeNumber: clip.takeNumber } : {}),
    units,
  };
}

function buildBroll(asset, dir) {
  const out = join(dir, 'broll', asset.file);
  mkdirSync(dirname(out), { recursive: true });
  const [w, h] = (asset.size ?? '540x960').split('x').map(Number);
  const label = asset.label.replace(/'/g, '').replace(/:/g, '\\:');
  const text = `drawtext=fontfile=${FONT}:text='${label}':fontsize=${Math.round(w / 14)}:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2`;
  if (asset.kind === 'image') {
    ff(['-f', 'lavfi', '-i', `gradients=s=${w}x${h}:c0=${asset.color ?? '0x355C7D'}:c1=0x101418:x0=0:y0=0:x1=${w}:y1=${h}`, '-vf', text, '-frames:v', '1', out]);
  } else {
    ff([
      '-f', 'lavfi', '-t', String(asset.durationSec ?? 4), '-i', `testsrc2=s=${w}x${h}:r=30`,
      '-vf', `colorchannelmixer=rr=0.5:gg=0.5:bb=0.7,${text}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-an', out,
    ]);
  }
  return { ...asset, file: `broll/${asset.file}` };
}

// ---- performances -------------------------------------------------------------

/** Ground truth units for one take, with line, take and group filled in. */
function takeUnits(perf, take, takeIndex, takeNumber) {
  return take.units.map((u) => {
    if (u.pause !== undefined || u.filler !== undefined) return { ...u };
    if (u.aside) return { ...u, keep: false, reason: u.reason ?? 'off_script', aside: true };
    const keep = u.keep === true;
    if (!keep && !['retake', 'false_start'].includes(u.reason)) {
      throw new Error(`${perf.id}: take ${takeIndex} reading "${u.say}" is cut but has no reason (retake or false_start)`);
    }
    return { ...u, keep, line: take.line, take: takeNumber, group: `L${take.line}` };
  });
}

/** Expands a performance into its recorded and uploaded fixture specs. */
export function expandPerformance(perf) {
  const lines = perf.script.length;
  const keptTake = new Map();
  const takeNo = new Map();
  const takes = perf.takes.map((take, i) => {
    if (!(take.line >= 0 && take.line < lines)) throw new Error(`${perf.id}: take ${i} has line ${take.line}, outside the script`);
    const n = (takeNo.get(take.line) ?? 0) + 1;
    takeNo.set(take.line, n);
    const units = takeUnits(perf, take, i, n);
    if (units.some((u) => u.keep && u.say !== undefined)) {
      if (keptTake.has(take.line) && keptTake.get(take.line) !== i) throw new Error(`${perf.id}: line ${take.line} is kept in two takes`);
      keptTake.set(take.line, i);
    }
    return { ...take, takeNumber: n, units };
  });
  for (let l = 0; l < lines; l++) if (!keptTake.has(l)) throw new Error(`${perf.id}: script line ${l} has no kept reading`);
  const recorded = {
    id: `${perf.id}-rec`,
    title: `${perf.title} (recorded)`,
    mode: perf.mode ?? 'general',
    form: 'recorded',
    performance: perf.id,
    script: perf.script,
    // The recorder uploads takes in script order, then take order.
    clips: [...takes]
      .sort((a, b) => a.line - b.line || a.takeNumber - b.takeNumber)
      .map((t) => ({
        name: `l${t.line + 1}_t${t.takeNumber}`,
        fps: perf.fps ?? 30,
        scriptLineIndex: t.line,
        takeNumber: t.takeNumber,
        leadIn: t.leadIn ?? 0.6,
        tail: t.tail ?? 0.6,
        units: t.units,
      })),
  };
  const splits = new Set(perf.upload?.splitBefore ?? []);
  const upClips = [];
  let cur = null;
  takes.forEach((t, i) => {
    if (!cur || splits.has(i)) {
      cur = { name: `upload${upClips.length + 1}`, fps: perf.fps ?? 30, leadIn: t.leadIn ?? 0.6, tail: 0.6, units: [] };
      upClips.push(cur);
    } else {
      cur.units.push({ pause: t.before ?? 1.2 });
    }
    cur.units.push(...t.units);
  });
  const uploaded = {
    id: `${perf.id}-up`,
    title: `${perf.title} (uploaded)`,
    mode: perf.mode ?? 'general',
    form: 'uploaded',
    performance: perf.id,
    script: null,
    clips: upClips,
  };
  return [recorded, uploaded];
}

// ---- main ---------------------------------------------------------------------

function listSpecs(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listSpecs(p));
    else if (name.endsWith('.json')) out.push(p);
  }
  return out;
}

function generate(spec, specFile) {
  const dir = join(outRoot, spec.id);
  const manifestPath = join(dir, 'manifest.json');
  const newest = Math.max(statSync(specFile).mtimeMs, statSync(self).mtimeMs);
  if (!force && existsSync(manifestPath) && statSync(manifestPath).mtimeMs > newest) return false;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const voice = join(outRoot, '.voice');
  const clips = spec.clips.map((c, i) => buildClip(c, i, dir, voice));
  const broll = (spec.broll ?? []).map((b) => buildBroll(b, dir));
  rmSync(join(dir, '.work'), { recursive: true, force: true });
  const manifest = {
    id: spec.id,
    title: spec.title,
    mode: spec.mode ?? 'general',
    script: spec.script ?? null,
    ...(spec.form ? { form: spec.form, performance: spec.performance } : {}),
    ...(spec.expect ? { expect: spec.expect } : {}),
    spec: relative(repo, specFile),
    clips,
    broll,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const total = clips.reduce((n, c) => n + c.durationSec, 0);
  console.log(`${spec.id}: ${clips.length} clip(s), ${round(total)}s, ${broll.length} b-roll -> ${relative(repo, dir)}`);
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === self) {
  let made = 0;
  for (const file of listSpecs(specRoot)) {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const specs = raw.takes ? expandPerformance(raw) : [raw];
    for (const spec of specs) {
      if (only && spec.id !== only && raw.id !== only) continue;
      if (generate(spec, file)) made++;
    }
  }
  if (!made) console.log(`Acceptance fixtures up to date in ${relative(repo, outRoot)}`);
}
