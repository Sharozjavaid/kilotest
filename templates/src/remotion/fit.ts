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

let ctx: CanvasRenderingContext2D | null = null;

/** The requested family, then the bundled Inter, so a missing theme font never falls back to a system face. */
function familyList(font: FontSpec): string {
  return `"${font.family}", "Kilo Inter", sans-serif`;
}
const cache = new Map<string, number>();

/** Width of `text` set at 1px. Text advances scale linearly with size. */
function unitWidth(text: string, font: FontSpec): number {
  const key = `${font.family}|${font.weight}|${font.tracking}|${font.uppercase ? 1 : 0}|${text}`;
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
  };
}

/**
 * Splits items of known widths into exactly `lines` lines, keeping order and
 * minimising the widest line (balanced lines, no orphan word on the last line).
 * Returns the index where each line starts.
 */
function balancedBreaks(widths: number[], gap: number, lines: number): number[] {
  const n = widths.length;
  const lineWidth = (i: number, j: number) => {
    let w = 0;
    for (let x = i; x < j; x++) w += widths[x]!;
    return w + gap * (j - i - 1);
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

function greedyLineCount(widths: number[], gap: number, maxWidth: number): number {
  let lines = 1;
  let cur = 0;
  for (const w of widths) {
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
    const count = greedyLineCount(widths, o.gapUnit * size, o.maxWidth);
    if (count > o.maxLines) continue;
    const height = count * o.lineUnit * size + (count - 1) * rowGap * size;
    if (height > o.maxHeight) continue;
    const starts = balancedBreaks(widths, o.gapUnit * size, Math.min(count, n));
    const lines: number[][] = [];
    for (let k = 0; k < starts.length; k++) {
      const s = starts[k]!;
      const e = k + 1 < starts.length ? starts[k + 1]! : n;
      lines.push(Array.from({ length: e - s }, (_, x) => s + x));
    }
    const lineWidths = lines.map((ix) => ix.reduce((a, i) => a + widths[i]!, 0) + (ix.length - 1) * o.gapUnit * size);
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
}

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
  const words = text.trim().split(/\s+/).filter(Boolean);
  const space = unitWidth(' ', o.font);
  const unit = words.map((w) => unitWidth(w, o.font));
  const flow = fitFlow({
    unit,
    gapUnit: space,
    maxWidth: o.maxWidth,
    lineUnit: o.lineHeight,
    maxHeight: o.maxHeight,
    maxLines: o.maxLines,
    maxSize: o.maxSize,
    minSize: o.minSize,
  });
  if (flow) {
    return { size: flow.size, lines: flow.lines.map((ix) => ix.map((i) => words[i]!)), lineWidths: flow.lineWidths };
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
    const height = lines.length * o.lineHeight * size;
    if (lines.length <= Math.max(o.maxLines, 1) * 2 && height <= o.maxHeight) {
      return { size, lines, lineWidths: lines.map((l) => measure(l.join(' '), o.font, size)) };
    }
  }
  const size = floor;
  const lines = words.flatMap((w) => breakWord(w, o.font, size, o.maxWidth)).map((w) => [w]);
  return { size, lines, lineWidths: lines.map((l) => measure(l.join(' '), o.font, size)) };
}

/** Widest of several single-line strings at 1px. */
export function unitOf(text: string, font: FontSpec): number {
  return unitWidth(text, font);
}
