#!/usr/bin/env node
// Builds synthetic test recordings with known word timings and known right answers.
// Needs ffmpeg and espeak-ng. Usage: node fixtures/generate.mjs [--only <id>] [--out <dir>]
//
// For each spec in fixtures/specs/*.json this writes, under fixtures/out/<id>/:
//   <clip>.mp4          the recording (speech with pauses, fillers, retakes)
//   <clip>.words.json   ground-truth transcript: { clipId, language, durationSec, words[] }
//   broll/*             synthetic B-roll files
//   manifest.json       everything a test needs: clips, units with keep/cut truth, script, broll
//
// Each mp4 also carries its transcript in the container `comment` tag as
// "kilo-words:<base64 of the words.json>", so the transcript survives an upload.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const outRoot = resolve(argOf('--out') ?? join(here, 'out'));
const only = argOf('--only');
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const GAP = 0.14; // natural gap between consecutive spoken units
const SR = 48000;

const run = (cmd, a) => execFileSync(cmd, a, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const ff = (a) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a]);
const durationOf = (p) =>
  parseFloat(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p]));
const round = (n) => Math.round(n * 1000) / 1000;

function speak(text, wavOut, tmp) {
  const raw = join(tmp, 'raw.wav');
  run('espeak-ng', ['-v', 'en-us', '-s', '160', '-w', raw, text]);
  // Trim leading and trailing silence so the unit's bounds are the speech itself.
  const trim = 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.01';
  ff(['-i', raw, '-af', `${trim},areverse,${trim},areverse,aresample=${SR}`, '-ac', '1', wavOut]);
  return durationOf(wavOut);
}

function buildClip(spec, clip, clipIndex, dir) {
  const tmp = join(dir, '.work', clip.name);
  mkdirSync(tmp, { recursive: true });
  const parts = []; // { file | silence, dur }
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
    const wav = join(tmp, `u${i}.wav`);
    const dur = speak(text, wav, tmp);
    const kind = u.filler ? 'filler' : 'speech';
    const keep = u.filler ? false : u.keep !== false;
    const reason = u.filler ? 'filler' : keep ? 'speech' : (u.reason ?? 'retake');
    units.push({ index: i, kind, start: round(t), end: round(t + dur), keep, reason, text, line: u.line, group: u.group });
    // Words inside a unit are spread by character count; unit bounds are exact.
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
    if (next && next.pause === undefined) {
      parts.push({ silence: GAP });
      t += GAP;
    }
  });
  const tail = clip.tail ?? 0.5;
  parts.push({ silence: tail });
  t += tail;
  const durationSec = round(t);

  // Audio: concatenate speech and silences, over a quiet noise floor like a real room.
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
    '-f', 'lavfi', '-t', String(durationSec), '-i', `anoisesrc=r=${SR}:c=pink:a=0.004`,
    '-filter_complex',
    `${labels.join('')}concat=n=${parts.length}:v=0:a=1[s];[s][${parts.length}:a]amix=inputs=2:duration=first:normalize=0[a]`,
    '-map', '[a]', '-ac', '1', '-ar', String(SR), audio,
  ]);

  // Video: a flat background with a band saying what is being spoken, so cuts are visible.
  const [w, h] = (clip.size ?? '720x1280').split('x').map(Number);
  const fps = clip.fps ?? 60;
  const draws = [];
  for (const u of units) {
    const label = u.kind === 'pause' ? '(silence)' : u.text;
    const file = join(tmp, `t${u.index}.txt`);
    writeFileSync(file, `${u.keep ? 'KEEP' : 'CUT ' + u.reason}\n${label.replace(/(.{1,26})(\s+|$)/g, '$1\n')}`);
    draws.push(
      `drawbox=x=0:y=ih*0.62:w=iw:h=ih*0.26:color=${u.keep ? '0x1F5EFF' : '0xB4441E'}@0.9:t=fill:enable='between(t,${u.start},${u.end})'`,
      `drawtext=fontfile=${FONT}:textfile=${file}:fontsize=${Math.round(w / 20)}:fontcolor=white:x=(w-text_w)/2:y=h*0.64:line_spacing=8:enable='between(t,${u.start},${u.end})'`,
    );
  }
  const bg = clip.background ?? ['0x2B3038', '0x3A2B38', '0x2B3830'][clipIndex % 3];
  const transcript = { clipId: clip.name, language: 'en', durationSec, words };
  const tag = 'kilo-words:' + Buffer.from(JSON.stringify(transcript)).toString('base64');
  const mp4 = join(dir, `${clip.name}.mp4`);
  ff([
    '-f', 'lavfi', '-t', String(durationSec), '-i', `color=c=${bg}:s=${w}x${h}:r=${fps}`,
    '-i', audio,
    '-vf', `drawtext=fontfile=${FONT}:text='${clip.name} %{pts\\:hms}':fontsize=${Math.round(w / 24)}:fontcolor=white@0.8:x=24:y=24,${draws.join(',')}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
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
    scriptLineIndex: clip.scriptLineIndex,
    takeNumber: clip.takeNumber,
    units,
  };
}

function buildBroll(asset, dir) {
  const out = join(dir, 'broll', asset.file);
  mkdirSync(dirname(out), { recursive: true });
  const [w, h] = (asset.size ?? '1080x1920').split('x').map(Number);
  const label = asset.label.replace(/'/g, '').replace(/:/g, '\\:');
  const text = `drawtext=fontfile=${FONT}:text='${label}':fontsize=${Math.round(w / 14)}:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2`;
  if (asset.kind === 'image') {
    ff(['-f', 'lavfi', '-i', `gradients=s=${w}x${h}:c0=${asset.color}:c1=0x101418:x0=0:y0=0:x1=${w}:y1=${h}`, '-vf', text, '-frames:v', '1', out]);
  } else {
    ff([
      '-f', 'lavfi', '-t', String(asset.durationSec ?? 4), '-i', `testsrc2=s=${w}x${h}:r=30`,
      '-vf', `colorchannelmixer=rr=0.5:gg=0.5:bb=0.7,${text}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-an', out,
    ]);
  }
  return { ...asset, file: `broll/${asset.file}` };
}

const specDir = join(here, 'specs');
for (const name of readdirSync(specDir).filter((f) => f.endsWith('.json')).sort()) {
  const spec = JSON.parse(readFileSync(join(specDir, name), 'utf8'));
  if (only && spec.id !== only) continue;
  const dir = join(outRoot, spec.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const clips = spec.clips.map((c, i) => buildClip(spec, c, i, dir));
  const broll = (spec.broll ?? []).map((b) => buildBroll(b, dir));
  rmSync(join(dir, '.work'), { recursive: true, force: true });
  const manifest = { id: spec.id, title: spec.title, mode: spec.mode ?? 'general', script: spec.script ?? null, clips, broll };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const total = clips.reduce((n, c) => n + c.durationSec, 0);
  console.log(`${spec.id}: ${clips.length} clip(s), ${round(total)}s, ${broll.length} b-roll -> ${dir}`);
}
