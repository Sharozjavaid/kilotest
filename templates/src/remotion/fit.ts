/**
 * Text measurement and auto-sizing, run in the render page with the bundled
 * fonts loaded. Measurements use a canvas with the same font, weight and
 * letter-spacing the DOM uses, and the layout code then renders exactly the
 * lines computed here (no browser wrapping), so what is measured is what is
 * drawn.
 */

export interface FontSpec {
  family: string;
  weight: number;
  /** Letter spacing in em. */
  tracking: number;
  uppercase?: boolean;
}

import { fallbackFamilies } from './scripts';

let ctx: CanvasRenderingContext2D | null = null;

/**
 * The requested family, then the bundled Inter, then the bundled faces for emoji and
 * other scripts (scripts.ts), so neither a missing theme font nor a character Inter lacks
 * ever falls back to a font of the machine.
 */
export function familyList(font: FontSpec): string {
  return [font.family, 'Kilo Inter', ...fallbackFamilies()].map((f) => `"${f}"`).join(', ') + ', sans-serif';
}
const cache = new Map<string, number>();

/** Width of `text` set at 1px. Text advances scale linearly with size. */
function unitWidth(text: string, font: FontSpec): number {
  const key = `${familyList(font)}|${font.weight}|${font.tracking}|${font.uppercase ? 1 : 0}|${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  if (!ctx) {
    const canvas = document.createElement('canvas');
    ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
  }
  const size = 200;
  ctx.font = `${font.weight} ${size}px ${familyList(font)}`;
  (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${font.tracking * size}px`;
  const s = font.uppercase ? text.toUpperCase() : text;
  const w = ctx.measureText(s).width / size;
  cache.set(key, w);
  return w;
}

export function measure(text: string, font: FontSpec, size: number): number {
  return unitWidth(text, font) * size;
}

export function fontCss(font: FontSpec, size: number): React.CSSProperties {
  return {
    fontFamily: familyList(font),
    fontWeight: font.weight,
    fontSize: size,
    letterSpacing: `${font.tracking}em`,
    textTransform: font.uppercase ? 'uppercase' : 'none',
    whiteSpace: 'pre',
    fontKerning: 'normal',
    fontFeatureSettings: '"kern" 1',
    // A line takes the direction of its own text (Arabic, Hebrew read right to left).
    unicodeBidi: 'plaintext',
  };
}

/**
 * Splits items of known widths into exactly `lines` lines, keeping order and
 * minimising the widest line (balanced lines, no orphan word on the last line).
 * Returns the index where each line starts.
 */
function balancedBreaks(widths: number[], gaps: number[], lines: number): number[] {
  const n = widths.length;
  const lineWidth = (i: number, j: number) => {
    let w = 0;
    for (let x = i; x < j; x++) w += widths[x]! + (x > i ? gaps[x]! : 0);
    return w;
  };
  // best[k][i]: minimal max width placing the first i items on k lines.
  const best: number[][] = Array.from({ length: lines + 1 }, () => new Array<number>(n + 1).fill(Infinity));
  const from: number[][] = Array.from({ length: lines + 1 }, () => new Array<number>(n + 1).fill(0));
  best[0]![0] = 0;
  for (let k = 1; k <= lines; k++) {
    for (let i = 1; i <= n; i++) {
      for (let s = k - 1; s < i; s++) {
        const prev = best[k - 1]![s]!;
        if (prev === Infinity) continue;
        const v = Math.max(prev, lineWidth(s, i));
        // Prefer longer lower lines on ties: a pyramid reads better than an inverted one.
        if (v < best[k]![i]! - 1e-9) {
          best[k]![i] = v;
          from[k]![i] = s;
        }
      }
    }
  }
  const starts: number[] = [];
  let i = n;
  for (let k = lines; k >= 1; k--) {
    const s = from[k]![i]!;
    starts.unshift(s);
    i = s;
  }
  return starts;
}

function greedyLineCount(widths: number[], gaps: number[], maxWidth: number): number {
  let lines = 1;
  let cur = 0;
  for (const [i, w] of widths.entries()) {
    const gap = gaps[i]!;
    if (cur === 0) cur = w;
    else if (cur + gap + w <= maxWidth) cur += gap + w;
    else {
      lines++;
      cur = w;
    }
  }
  return lines;
}

/**
 * Lays out items (words or chips) of width `unit[i] * size + pad * size` into
 * balanced lines. Used for both plain text and chip rows.
 */
export interface FlowFit {
  size: number;
  /** Item indices on each line. */
  lines: number[][];
  /** Width of each line in px at `size`. */
  lineWidths: number[];
}

export interface FlowOptions {
  /** Item widths at 1px, including any per-item padding. */
  unit: number[];
  /** Gap between items at 1px. */
  gapUnit: number;
  /** Per item: the gap before it at 1px, when not `gapUnit` (0 for characters of a script written without spaces). */
  gapsBeforeUnit?: number[];
  maxWidth: number;
  /** Height of one line at 1px (line-height or chip height plus row gap). */
  lineUnit: number;
  /** Extra vertical space per line break at 1px (row gap). */
  rowGapUnit?: number;
  maxHeight: number;
  maxLines: number;
  maxSize: number;
  minSize: number;
}

export function fitFlow(o: FlowOptions): FlowFit | null {
  const n = o.unit.length;
  const rowGap = o.rowGapUnit ?? 0;
  for (let size = Math.floor(o.maxSize); size >= o.minSize; size--) {
    const widths = o.unit.map((u) => u * size);
    if (widths.some((w) => w > o.maxWidth)) continue;
    const gaps = o.unit.map((_, i) => (o.gapsBeforeUnit?.[i] ?? o.gapUnit) * size);
    const count = greedyLineCount(widths, gaps, o.maxWidth);
    if (count > o.maxLines) continue;
    const height = count * o.lineUnit * size + (count - 1) * rowGap * size;
    if (height > o.maxHeight) continue;
    const starts = balancedBreaks(widths, gaps, Math.min(count, n));
    const lines: number[][] = [];
    for (let k = 0; k < starts.length; k++) {
      const s = starts[k]!;
      const e = k + 1 < starts.length ? starts[k + 1]! : n;
      lines.push(Array.from({ length: e - s }, (_, x) => s + x));
    }
    const lineWidths = lines.map((ix) => ix.reduce((a, i, k) => a + widths[i]! + (k > 0 ? gaps[i]! : 0), 0));
    if (lineWidths.some((w) => w > o.maxWidth)) continue;
    return { size, lines, lineWidths };
  }
  return null;
}

export interface TextFit {
  size: number;
  /** Lines of words. */
  lines: string[][];
  lineWidths: number[];
  /**
   * Line pitch in em to draw with: the requested line height, or more when the text's
   * own ink is taller (marks above capitals, emoji), so adjacent lines never touch.
   */
  line: number;
}

/** Scripts written without spaces: a line may break between any two of their characters. */
const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\u3000-\u303f\uff00-\uffef]/u;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Words split further into characters where the script has no spaces; `glued` tokens join the one before without a space. */
function tokenize(text: string): Array<{ text: string; glued: boolean }> {
  const out: Array<{ text: string; glued: boolean }> = [];
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    if (!NO_SPACE_SCRIPT.test(word)) {
      out.push({ text: word, glued: false });
      continue;
    }
    let first = true;
    let run = '';
    for (const { segment } of segmenter.segment(word)) {
      // Characters of other scripts stay together ("SPF50", "1,980").
      if (NO_SPACE_SCRIPT.test(segment) || !run) {
        if (run) {
          out.push({ text: run, glued: !first });
          first = false;
        }
        run = segment;
        if (NO_SPACE_SCRIPT.test(segment)) {
          out.push({ text: run, glued: !first });
          first = false;
          run = '';
        }
      } else run += segment;
    }
    if (run) out.push({ text: run, glued: !first });
  }
  return out;
}

/** Rebuilds lines of words from lines of tokens, joining glued tokens. */
function joinTokens(tokens: Array<{ text: string; glued: boolean }>, line: number[]): string[] {
  const words: string[] = [];
  line.forEach((i, k) => {
    const t = tokens[i]!;
    if (k > 0 && t.glued) words[words.length - 1] += t.text;
    else words.push(t.text);
  });
  return words;
}

/** Height of the text's ink at 1px: the tallest ascent plus the deepest descent of any character. */
function inkHeight(text: string, font: FontSpec): number {
  unitWidth(' ', font); // creates the context
  const size = 200;
  ctx!.font = `${font.weight} ${size}px ${familyList(font)}`;
  const m = ctx!.measureText(font.uppercase ? text.toUpperCase() : text);
  const h = (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) / size;
  // A canvas that reports no ink box (or an empty string) must never turn a layout into NaN.
  return Number.isFinite(h) ? h : 0;
}

/** Space kept between the ink of two lines, in em. */
const LINE_INK_GAP = 0.06;

export interface TextOptions {
  font: FontSpec;
  maxWidth: number;
  maxHeight: number;
  lineHeight: number;
  maxLines: number;
  maxSize: number;
  /** Smallest size before long words are broken across lines. */
  minSize: number;
  /** Absolute floor, used only for text that cannot otherwise fit. */
  floorSize?: number;
}

/** Splits a word that is wider than `maxWidth` into hyphenated pieces. */
function breakWord(word: string, font: FontSpec, size: number, maxWidth: number): string[] {
  const pieces: string[] = [];
  let rest = word;
  while (measure(rest, font, size) > maxWidth && rest.length > 1) {
    let cut = rest.length - 1;
    while (cut > 1 && measure(rest.slice(0, cut) + '-', font, size) > maxWidth) cut--;
    pieces.push(rest.slice(0, cut) + '-');
    rest = rest.slice(cut);
  }
  pieces.push(rest);
  return pieces;
}

/** Fits text into a box: the largest size at which it wraps into at most `maxLines` balanced lines. */
export function fitText(text: string, o: TextOptions): TextFit {
  const tokens = tokenize(text);
  const words = tokens.map((t) => t.text);
  const space = unitWidth(' ', o.font);
  const unit = words.map((w) => unitWidth(w, o.font));
  const line = Math.max(o.lineHeight, inkHeight(text, o.font) + LINE_INK_GAP);
  const flow = fitFlow({
    unit,
    gapUnit: space,
    gapsBeforeUnit: tokens.map((t) => (t.glued ? 0 : space)),
    maxWidth: o.maxWidth,
    lineUnit: line,
    maxHeight: o.maxHeight,
    maxLines: o.maxLines,
    maxSize: o.maxSize,
    minSize: o.minSize,
  });
  if (flow) {
    return { size: flow.size, lines: flow.lines.map((ix) => joinTokens(tokens, ix)), lineWidths: flow.lineWidths, line };
  }
  // Only reachable for pathological input (a very long single word): break words.
  const floor = o.floorSize ?? Math.max(8, Math.floor(o.minSize * 0.5));
  for (let size = Math.floor(o.minSize); size >= floor; size--) {
    const tokens = words.flatMap((w) => breakWord(w, o.font, size, o.maxWidth));
    const lines: string[][] = [];
    let cur: string[] = [];
    let curW = 0;
    for (const tok of tokens) {
      const w = measure(tok, o.font, size);
      const forceBreak = cur.length > 0 && cur[cur.length - 1]!.endsWith('-');
      if (cur.length === 0) {
        cur = [tok];
        curW = w;
      } else if (!forceBreak && curW + space * size + w <= o.maxWidth) {
        cur.push(tok);
        curW += space * size + w;
      } else {
        lines.push(cur);
        cur = [tok];
        curW = w;
      }
    }
    if (cur.length) lines.push(cur);
    const height = lines.length * line * size;
    if (lines.length <= Math.max(o.maxLines, 1) * 2 && height <= o.maxHeight) {
      return { size, lines, lineWidths: lines.map((l) => measure(l.join(' '), o.font, size)), line };
    }
  }
  const size = floor;
  const lines = words.flatMap((w) => breakWord(w, o.font, size, o.maxWidth)).map((w) => [w]);
  return { size, lines, lineWidths: lines.map((l) => measure(l.join(' '), o.font, size)), line };
}

/** Widest of several single-line strings at 1px. */
export function unitOf(text: string, font: FontSpec): number {
  return unitWidth(text, font);
}
