/**
 * Writes a contact sheet per template into .work/preview/: several moments
 * across the duration for each theme, plus the longest-text and
 * shortest-text cases, composited over a footage-like background with the
 * platform safe-area guides drawn in.
 *
 *   npm run preview                       # 540x960 @ 30
 *   npm run preview -- --full             # 1080x1920 @ 60 (slow)
 *   npm run preview -- --only=price-tag
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { GRAPHIC_THEMES, getTemplate, type GraphicTheme, type TemplateId } from '@kilo/edl';
import { PREVIEW_CASES } from './cases.js';
import { shutdown, templates } from '../src/index.js';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, '.work', 'preview');
const FONT = path.join(ROOT, 'assets', 'fonts', 'Inter-Bold.otf');

const args = process.argv.slice(2);
const full = args.includes('--full');
const only = args.find((a) => a.startsWith('--only='))?.slice(7);
const W = full ? 1080 : 540;
const H = full ? 1920 : 960;
const FPS = full ? 60 : 30;
const CELL_W = 270;
const CELL_H = 480;
/** Moments as fractions of the duration: entrance, entrance, landed, hold, exit, exit. */
const MOMENTS = [0.05, 0.13, 0.3, 0.55, 0.9, 0.965];

async function ffmpeg(a: string[]) {
  await run('ffmpeg', ['-v', 'error', '-y', ...a], { maxBuffer: 1 << 24 });
}

async function background(): Promise<string> {
  const p = path.join(OUT, `bg-${W}x${H}.png`);
  if (existsSync(p)) return p;
  // A footage-like plate: a light-to-dark gradient with a soft head-and-shoulders shape,
  // so legibility shows over both bright and dark areas. Faint lines mark the safe area.
  const s = W / 1080;
  const geq = [
    `r='clip(150-60*Y/H+70*exp(-((X-W/2)^2+(Y-0.36*H)^2)/(2*(${170 * s})^2))-40*exp(-((X-W/2)^2/(2*(${330 * s})^2)))*gt(Y,0.55*H),0,255)'`,
    `g='clip(146-62*Y/H+60*exp(-((X-W/2)^2+(Y-0.36*H)^2)/(2*(${170 * s})^2))-38*exp(-((X-W/2)^2/(2*(${330 * s})^2)))*gt(Y,0.55*H),0,255)'`,
    `b='clip(150-50*Y/H+52*exp(-((X-W/2)^2+(Y-0.36*H)^2)/(2*(${170 * s})^2))-30*exp(-((X-W/2)^2/(2*(${330 * s})^2)))*gt(Y,0.55*H),0,255)'`,
  ].join(':');
  const guides = [
    `drawbox=x=0:y=${Math.round(H * 0.12)}:w=${W}:h=1:color=red@0.6:t=fill`,
    `drawbox=x=0:y=${Math.round(H * 0.78)}:w=${W}:h=1:color=red@0.6:t=fill`,
    `drawbox=x=${Math.round(W * 0.86)}:y=${H / 2}:w=1:h=${H / 2}:color=red@0.6:t=fill`,
  ].join(',');
  await ffmpeg(['-f', 'lavfi', '-i', `color=c=gray:s=${W}x${H}`, '-vf', `format=rgb24,geq=${geq},${guides}`, '-frames:v', '1', p]);
  return p;
}

async function row(mov: string, durationSec: number, label: string, out: string, bg: string) {
  const frames = Math.round(durationSec * FPS);
  const idx = MOMENTS.map((m) => Math.min(frames - 1, Math.round(m * durationSec * FPS)));
  const select = idx.map((i) => `eq(n\\,${i})`).join('+');
  const esc = label.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, '');
  await ffmpeg([
    '-loop', '1', '-framerate', String(FPS), '-i', bg, '-i', mov,
    '-filter_complex',
    `[0][1]overlay=shortest=1:format=auto,select='${select}',scale=${CELL_W}:${CELL_H}:flags=lanczos,` +
      `pad=iw+8:ih+8:4:4:color=0x1a1a1a,tile=${MOMENTS.length}x1,pad=iw:ih+44:0:44:color=0x1a1a1a,` +
      `drawtext=fontfile=${FONT}:text='${esc}':x=12:y=12:fontsize=22:fontcolor=white`,
    '-frames:v', '1', '-vsync', '0', out,
  ]);
}

async function main() {
  await fs.mkdir(path.join(OUT, 'movs'), { recursive: true });
  const bg = await background();
  const ids = (Object.keys(PREVIEW_CASES) as TemplateId[]).filter((id) => !only || id === only);
  const timings: string[] = [];
  for (const id of ids) {
    const spec = getTemplate(id);
    const rows: string[] = [];
    const jobs: Array<{ label: string; props: Record<string, unknown>; theme: GraphicTheme; durationSec: number }> = [];
    for (const theme of GRAPHIC_THEMES) {
      jobs.push({ label: `${theme.name} | example | ${spec.defaultDurationSec}s`, props: spec.example, theme, durationSec: spec.defaultDurationSec });
    }
    for (const c of PREVIEW_CASES[id]) {
      const theme = GRAPHIC_THEMES.find((t) => t.id === c.theme) ?? GRAPHIC_THEMES[0]!;
      const durationSec = c.durationSec ?? spec.defaultDurationSec;
      jobs.push({ label: `${theme.name} | ${c.name} | ${durationSec}s`, props: c.props, theme, durationSec });
    }
    for (const [i, j] of jobs.entries()) {
      const mov = path.join(OUT, 'movs', `${id}-${i}-${W}.mov`);
      const t0 = Date.now();
      await templates.renderGraphic({ template: id, props: j.props, theme: j.theme, durationSec: j.durationSec, fps: FPS, width: W, height: H, outPath: mov });
      timings.push(`${id} #${i} ${Date.now() - t0} ms`);
      const r = path.join(OUT, `row-${id}-${i}.png`);
      await row(mov, j.durationSec, j.label, r, bg);
      rows.push(r);
    }
    const sheet = path.join(OUT, `${id}${full ? '-full' : ''}.png`);
    await ffmpeg([...rows.flatMap((r) => ['-i', r]), '-filter_complex', `${rows.map((_, i) => `[${i}]`).join('')}vstack=inputs=${rows.length}`, sheet]);
    await Promise.all(rows.map((r) => fs.rm(r)));
    console.log(`wrote ${path.relative(ROOT, sheet)}`);
  }
  console.log(timings.join('\n'));
  await shutdown();
}

main().catch(async (err) => {
  console.error(err);
  await shutdown();
  process.exit(1);
});
