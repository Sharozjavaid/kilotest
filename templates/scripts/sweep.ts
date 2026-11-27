import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { openBrowser, renderStill, selectComposition } from '@remotion/renderer';
import { GRAPHIC_THEMES, TEMPLATES, type GraphicTheme, type TemplateId } from '@kilo/edl';
import { findBrowserExecutable, getBundle, PACKAGE_ROOT } from '../src/renderer.js';
import type { ProbeResult, ProbeRect } from '../src/remotion/probe.js';
import { assertCasesValid, SWEEP_CASES, type SweepCase } from './sweep-cases.js';

/**
 * Phase 4 acceptance: "Each template renders correctly on text of any reasonable length."
 *
 * Every template x theme x text case (scripts/sweep-cases.ts) is rendered as a still at
 * 1080x1920, at 70% of its default duration (every element has entered, none has
 * started to leave), with the composition's layout probe on (src/remotion/probe.ts):
 * the page reports what it drew, measured with its own font metrics. Checks:
 *
 * - clipped: every text's ink box lies inside the frame, inside every ancestor that
 *   clips, and inside the box (card, chip, badge, pill) that contains it;
 * - safe area: text and every painted box other than a full-screen plate stay below
 *   the top 12%, above the bottom 22%, and, where they reach the lower half, left of
 *   the right-hand 14% (the platform's like/comment rail); and inside the frame width;
 * - overlap: no glyph (grapheme cluster ink box) of one text intersects a glyph of another, no text overlaps a painted box that is
 *   not its own container (a strike line marked as decoration excepted), and no two
 *   painted boxes overlap unless one contains the other;
 * - line breaks: a script written without spaces (Japanese, Chinese, Thai) is never
 *   broken with a hyphen as if it were one long word;
 * - readable: every text is drawn at least MIN_READABLE_PX on a 1080-wide frame;
 * - glyphs: no character draws as the missing-glyph box, and for cases the bundled
 *   Inter should cover, every character is in Inter's character map. Characters Inter
 *   lacks are reported with the system fonts that have them: those come from the
 *   machine, not from Kilo.
 */

/** About 13 pt on a 390 pt wide phone screen; 3.3% of the frame width. */
export const MIN_READABLE_PX = 36;
const TOL = 1;
const OUT = path.join(PACKAGE_ROOT, '.work', 'sweep');

// ---- Inter's character map -----------------------------------------------------------

/** Code points in an OpenType font's cmap (formats 4 and 12). */
export function cmapOf(file: string): Set<number> {
  const b = readFileSync(file);
  const numTables = b.readUInt16BE(4);
  let cmap = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (b.toString('ascii', rec, rec + 4) === 'cmap') cmap = b.readUInt32BE(rec + 8);
  }
  if (cmap < 0) throw new Error(`${file}: no cmap`);
  const out = new Set<number>();
  const n = b.readUInt16BE(cmap + 2);
  for (let i = 0; i < n; i++) {
    const off = cmap + b.readUInt32BE(cmap + 4 + i * 8 + 4);
    const format = b.readUInt16BE(off);
    if (format === 4) {
      const segX2 = b.readUInt16BE(off + 6);
      const ends = off + 14;
      const starts = ends + segX2 + 2;
      for (let s = 0; s < segX2 / 2; s++) {
        const end = b.readUInt16BE(ends + s * 2);
        const start = b.readUInt16BE(starts + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) out.add(c);
      }
    } else if (format === 12) {
      const groups = b.readUInt32BE(off + 12);
      for (let g = 0; g < groups; g++) {
        const start = b.readUInt32BE(off + 16 + g * 12);
        const end = b.readUInt32BE(off + 20 + g * 12);
        for (let c = start; c <= end; c++) out.add(c);
      }
    }
  }
  return out;
}

let interMap: Set<number> | null = null;
function inInter(ch: string): boolean {
  if (!interMap) {
    const dir = path.join(PACKAGE_ROOT, 'assets', 'fonts');
    const maps = ['Inter-Bold.otf', 'InterDisplay-ExtraBold.otf'].map((f) => cmapOf(path.join(dir, f)));
    interMap = new Set([...maps[0]!].filter((c) => maps.every((m) => m.has(c))));
  }
  // Variation selectors and joiners are not drawn on their own.
  return [...ch].every((c) => {
    const cp = c.codePointAt(0)!;
    return interMap!.has(cp) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x200d;
  });
}

const fallbackMemo = new Map<string, string>();
/** System font families that have `ch` (fontconfig), for the report. */
function systemFontsWith(ch: string): string {
  const hit = fallbackMemo.get(ch);
  if (hit !== undefined) return hit;
  let fams = '';
  try {
    const hex = ch.codePointAt(0)!.toString(16);
    const list = execFileSync('fc-list', [`:charset=${hex}`, 'family'], { encoding: 'utf8' })
      .split('\n').map((l) => l.split(',')[0]!.trim()).filter(Boolean);
    fams = [...new Set(list)].sort().slice(0, 3).join(', ');
  } catch {
    fams = '';
  }
  fallbackMemo.set(ch, fams);
  return fams;
}

// ---- checks ---------------------------------------------------------------------------

const inside = (a: ProbeRect, b: ProbeRect) => a.left >= b.left - TOL && a.right <= b.right + TOL && a.top >= b.top - TOL && a.bottom <= b.bottom + TOL;
function intersects(a: ProbeRect, b: ProbeRect): boolean {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > TOL && h > TOL;
}
const fmt = (r: ProbeRect) => `[${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.right)},${Math.round(r.bottom)}]`;
const short = (t: string) => (t.length > 24 ? `${t.slice(0, 22)}…` : t);

export interface CaseResult {
  template: TemplateId;
  theme: string;
  kind: string;
  covered: boolean;
  still: string;
  problems: string[];
  /** Characters Inter does not have, with what the system draws them with. */
  fallback: string[];
  minSizePx: number;
}

export function checkProbe(p: ProbeResult, c: SweepCase): { problems: string[]; fallback: string[]; minSizePx: number } {
  const problems: string[] = [];
  const W = p.width;
  const H = p.height;
  const s = W / 1080;
  const frame = { left: 0, top: 0, right: W, bottom: H };
  const safe = { top: H * 0.12, bottom: H * 0.78, right: W * 0.86 };
  const box = (id: number) => p.boxes[id]!;
  const inSafe = (r: ProbeRect, what: string) => {
    if (r.top < safe.top - TOL) problems.push(`${what} reaches into the top 12% (top ${Math.round(r.top)} < ${Math.round(safe.top)})`);
    if (r.bottom > safe.bottom + TOL) problems.push(`${what} reaches into the bottom 22% (bottom ${Math.round(r.bottom)} > ${Math.round(safe.bottom)})`);
    if (r.bottom > H / 2 && r.right > safe.right + TOL) problems.push(`${what} reaches the right-hand rail in the lower half (right ${Math.round(r.right)} > ${Math.round(safe.right)})`);
    if (r.left < -TOL || r.right > W + TOL) problems.push(`${what} leaves the frame horizontally ${fmt(r)}`);
  };
  if (!p.texts.length) problems.push('no text was drawn');
  let minSizePx = Infinity;
  for (const t of p.texts) {
    const what = `"${short(t.text)}"`;
    minSizePx = Math.min(minSizePx, t.sizePx / s);
    if (!inside(t.ink, frame)) problems.push(`${what} is clipped by the frame ${fmt(t.ink)}`);
    for (const id of t.clips) if (!inside(t.ink, box(id).rect)) problems.push(`${what} is clipped by its container ${fmt(box(id).rect)}, ink ${fmt(t.ink)}`);
    if (t.container !== null && !inside(t.ink, box(t.container).rect)) problems.push(`${what} spills out of its box ${fmt(box(t.container).rect)}, ink ${fmt(t.ink)}`);
    inSafe(t.ink, `text ${what}`);
    if (t.sizePx / s < MIN_READABLE_PX - 0.5) problems.push(`${what} is drawn at ${(t.sizePx / s).toFixed(0)} px, under the readable ${MIN_READABLE_PX} px`);
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]-$/u.test(t.text)) problems.push(`${what} breaks a script written without spaces with a hyphen`);
    if (t.tofu.length) problems.push(`${what} draws ${t.tofu.map((ch) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase()}`).join(' ')} as the missing-glyph box`);
  }
  for (let i = 0; i < p.texts.length; i++) {
    for (let j = i + 1; j < p.texts.length; j++) {
      const a = p.texts[i]!;
      const b = p.texts[j]!;
      if (!intersects(a.ink, b.ink)) continue;
      const hit = a.glyphs.flatMap((ga) => b.glyphs.filter((gb) => intersects(ga, gb)).map((gb) => [ga, gb] as const))[0];
      if (hit) problems.push(`"${short(a.text)}" and "${short(b.text)}" overlap: glyphs ${fmt(hit[0])} and ${fmt(hit[1])}`);
    }
    const t = p.texts[i]!;
    for (const b of p.boxes) {
      if (!b.paints || b.plate || b.decoration || t.ancestors.includes(b.id)) continue;
      if (t.glyphs.some((g) => intersects(g, b.rect))) problems.push(`"${short(t.text)}" overlaps a box it is not in ${fmt(b.rect)}`);
    }
  }
  const ancestorsOf = (id: number) => {
    const out: number[] = [];
    for (let x = box(id).parent; x !== null; x = box(x).parent) out.push(x);
    return out;
  };
  const painted = p.boxes.filter((b) => b.paints && !b.plate);
  for (const b of painted) if (!b.decoration) inSafe(b.rect, `box ${fmt(b.rect)}`);
  for (let i = 0; i < painted.length; i++) {
    for (let j = i + 1; j < painted.length; j++) {
      const a = painted[i]!;
      const b = painted[j]!;
      if (a.decoration || b.decoration || ancestorsOf(a.id).includes(b.id) || ancestorsOf(b.id).includes(a.id)) continue;
      if (intersects(a.rect, b.rect)) problems.push(`boxes ${fmt(a.rect)} and ${fmt(b.rect)} overlap`);
    }
  }
  const chars = new Set(p.texts.flatMap((t) => [...t.text.replace(/\s+/g, '')]));
  const missing = [...chars].filter((ch) => !inInter(ch));
  if (c.covered && missing.length) problems.push(`Inter should cover this text but lacks ${missing.join(' ')}`);
  const fallback = missing.map((ch) => `${ch} U+${ch.codePointAt(0)!.toString(16).toUpperCase()}: ${systemFontsWith(ch) || 'no installed font'}`);
  return { problems: [...new Set(problems)], fallback, minSizePx: Number.isFinite(minSizePx) ? minSizePx : 0 };
}

// ---- the sweep ------------------------------------------------------------------------

export interface SweepOptions {
  templates?: TemplateId[];
  themes?: string[];
  kinds?: string[];
  width?: number;
  height?: number;
  log?: (line: string) => void;
}

export async function runSweep(opts: SweepOptions = {}): Promise<CaseResult[]> {
  assertCasesValid();
  const W = opts.width ?? 1080;
  const H = opts.height ?? 1920;
  const log = opts.log ?? (() => {});
  const serveUrl = await getBundle();
  const browserExecutable = findBrowserExecutable();
  const chromiumOptions = { gl: (process.env.KILO_TEMPLATES_GL || 'swangle') as 'swangle' };
  const browser = await openBrowser('chrome', { browserExecutable, chromiumOptions, logLevel: 'error', chromeMode: 'headless-shell' });
  const results: CaseResult[] = [];
  try {
    const base = await selectComposition({ serveUrl, id: 'graphic', puppeteerInstance: browser, browserExecutable, chromiumOptions, logLevel: 'error' });
    for (const spec of TEMPLATES) {
      if (opts.templates && !opts.templates.includes(spec.id)) continue;
      for (const theme of GRAPHIC_THEMES as readonly GraphicTheme[]) {
        if (opts.themes && !opts.themes.includes(theme.id)) continue;
        for (const [ci, c] of SWEEP_CASES[spec.id].entries()) {
          if (opts.kinds && !opts.kinds.includes(c.kind)) continue;
          const durationSec = spec.defaultDurationSec;
          const fps = 30;
          const frames = Math.round(durationSec * fps);
          const frame = Math.round(frames * 0.7);
          const props = {
            template: spec.id, props: c.props, theme, durationSec, fps, width: W, height: H,
            defaultDurationSec: spec.defaultDurationSec, probe: true,
          };
          const dir = path.join(OUT, spec.id);
          await fs.mkdir(dir, { recursive: true });
          const still = path.join(dir, `${theme.id}-${String(ci).padStart(2, '0')}.png`);
          let probe: ProbeResult | null = null;
          let error: string | null = null;
          try {
            await renderStill({
              serveUrl,
              composition: { ...base, width: W, height: H, fps, durationInFrames: frames, props },
              inputProps: props,
              frame,
              output: still,
              imageFormat: 'png',
              overwrite: true,
              puppeteerInstance: browser,
              browserExecutable,
              chromiumOptions,
              logLevel: 'error',
              timeoutInMilliseconds: 60000,
              onBrowserLog: (l) => {
                if (l.text.startsWith('KILO_PROBE ')) probe = JSON.parse(l.text.slice('KILO_PROBE '.length)) as ProbeResult;
              },
            });
          } catch (e) {
            error = (e as Error).message.split('\n')[0]!;
          }
          const got = probe as ProbeResult | null;
          const checked = got ? checkProbe(got, c) : { problems: [`did not render: ${error ?? 'no probe output'}`], fallback: [], minSizePx: 0 };
          const r: CaseResult = { template: spec.id, theme: theme.id, kind: c.kind, covered: c.covered, still, ...checked };
          results.push(r);
          log(`${r.problems.length ? 'FAIL' : 'ok  '} ${spec.id} / ${theme.id} / ${c.kind}: min ${r.minSizePx.toFixed(0)} px${r.problems.length ? `\n       ${r.problems.join('\n       ')}` : ''}`);
        }
      }
    }
  } finally {
    await browser.close({ silent: true });
  }
  return results;
}

/** One contact sheet per template: a row per theme, a column per case. */
export async function contactSheets(results: CaseResult[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of [...new Set(results.map((r) => r.template))]) {
    const rs = results.filter((r) => r.template === id);
    const themes = [...new Set(rs.map((r) => r.theme))];
    const cols = Math.max(...themes.map((t) => rs.filter((r) => r.theme === t).length));
    const sheet = path.join(OUT, `${id}-sheet.png`);
    const inputs = rs.flatMap((r) => ['-i', r.still]);
    const filters = rs.map((_, i) => `[${i}:v]scale=216:384,drawbox=y=ih*0.12:w=iw:h=1:color=red,drawbox=y=ih*0.78:w=iw:h=1:color=red,drawbox=x=iw*0.86:y=ih/2:w=1:h=ih/2:color=red[v${i}]`);
    const layout = rs.map((_, i) => `${(i % cols) * 216}_${Math.floor(i / cols) * 384}`).join('|');
    execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex',
      `color=c=0x3A4250:s=${cols * 216}x${themes.length * 384}[bg];${filters.join(';')};${rs.map((_, i) => `[v${i}]`).join('')}xstack=inputs=${rs.length}:layout=${layout}:fill=0x3A4250[x];[bg][x]overlay[o]`,
      '-map', '[o]', '-frames:v', '1', sheet]);
    out.push(sheet);
  }
  return out;
}

export function formatSweep(results: CaseResult[]): string {
  const lines: string[] = [];
  const failed = results.filter((r) => r.problems.length);
  for (const id of [...new Set(results.map((r) => r.template))]) {
    const rs = results.filter((r) => r.template === id);
    lines.push(`${id}: ${rs.length - rs.filter((r) => r.problems.length).length}/${rs.length} cases pass; smallest text ${Math.min(...rs.map((r) => r.minSizePx)).toFixed(0)} px`);
    for (const r of rs.filter((x) => x.problems.length)) lines.push(`  FAIL ${r.theme} / ${r.kind}: ${r.problems.join('; ')}`);
  }
  const fb = new Map<string, Set<string>>();
  for (const r of results) for (const f of r.fallback) fb.set(r.kind, (fb.get(r.kind) ?? new Set()).add(f));
  if (fb.size) {
    lines.push('', 'Characters the bundled Inter does not have (drawn by whatever font the machine has):');
    for (const [kind, set] of fb) lines.push(`  ${kind}: ${[...set].slice(0, 6).join('; ')}${set.size > 6 ? `; and ${set.size - 6} more` : ''}`);
  }
  lines.push('', `Cases: ${results.length}; passing: ${results.length - failed.length}; failing: ${failed.length}.`);
  return lines.join('\n');
}
