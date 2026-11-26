import type { CaptionStyle, Transcript } from '@kilo/edl';
import type { PlanItem, PlanOverlay } from './plan.js';

/** A word placed on the output timeline. */
export interface OutWord {
  text: string;
  start: number;
  end: number;
  /** Index of the plan item it plays in. */
  item: number;
}

/**
 * Maps transcript words from their source clips onto the output timeline. A word
 * belongs to the item whose source range holds its midpoint; words in cut segments
 * vanish, and reordered variants carry their words with them.
 */
export function mapWords(items: PlanItem[], transcripts: Transcript[], fps: number): OutWord[] {
  const byClip = new Map<string, Transcript>();
  for (const t of transcripts) byClip.set(t.clipId, t);
  const out: OutWord[] = [];
  for (const it of items) {
    const tr = byClip.get(it.clipId);
    if (!tr) continue;
    const segStart = it.segment.start;
    const segEnd = it.segment.end;
    const outStart = it.frameStart / fps;
    const outEnd = (it.frameStart + it.frames) / fps;
    for (const w of tr.words) {
      const mid = (w.start + w.end) / 2;
      if (mid < segStart || mid >= segEnd) continue;
      const s = Math.max(outStart, outStart + (w.start - it.srcStart));
      const e = Math.min(outEnd, outStart + (w.end - it.srcStart));
      if (e - s < 0.02) continue;
      const text = w.text.trim();
      if (!text) continue;
      out.push({ text, start: s, end: e, item: it.index });
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

export interface Cue {
  words: OutWord[];
  start: number;
  end: number;
}

interface GroupRule {
  maxWords: number;
  maxChars: number;
  minWords: number;
}

const RULES: Record<CaptionStyle, GroupRule> = {
  clean: { maxWords: 7, maxChars: 34, minWords: 1 },
  bold: { maxWords: 4, maxChars: 18, minWords: 2 },
  karaoke: { maxWords: 6, maxChars: 30, minWords: 1 },
};

const SENTENCE_END = /[.!?…]["')\]]*$/;
const CLAUSE_END = /[,;:]["')\]]*$/;

/** Groups words into cues: by pauses, sentence ends, cuts between non-adjacent source, and size. */
export function groupCues(words: OutWord[], style: CaptionStyle, items: PlanItem[]): Cue[] {
  const rule = RULES[style];
  const cues: Cue[] = [];
  let cur: OutWord[] = [];
  const chars = (ws: OutWord[]) => ws.reduce((n, w) => n + w.text.length, 0) + Math.max(0, ws.length - 1);
  const flush = () => {
    if (cur.length) cues.push({ words: cur, start: cur[0]!.start, end: cur[cur.length - 1]!.end });
    cur = [];
  };
  const jumpBetween = (a: OutWord, b: OutWord) => {
    if (a.item === b.item) return false;
    const ia = items[a.item]!;
    const ib = items[b.item]!;
    return ia.clipId !== ib.clipId || ib.segment.start + 1e-3 < ia.segment.end || ib.segment.start - ia.segment.end > 0.6;
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const prev = cur[cur.length - 1];
    if (prev) {
      const gap = w.start - prev.end;
      const tooBig = cur.length + 1 > rule.maxWords || chars([...cur, w]) > rule.maxChars;
      const softBreak = SENTENCE_END.test(prev.text) || (CLAUSE_END.test(prev.text) && cur.length >= rule.minWords);
      if (gap > 0.45 || jumpBetween(prev, w) || tooBig || softBreak) flush();
    }
    cur.push(w);
  }
  flush();
  // Bold shows 2-4 words: fold a lone trailing word into its neighbour when it still fits.
  if (style === 'bold') {
    for (let i = cues.length - 1; i > 0; i--) {
      const c = cues[i]!;
      const p = cues[i - 1]!;
      if (c.words.length === 1 && p.words.length < 4 && c.start - p.end < 0.3 && !SENTENCE_END.test(p.words[p.words.length - 1]!.text)) {
        p.words.push(...c.words);
        p.end = c.end;
        cues.splice(i, 1);
      }
    }
  }
  // Hold each cue briefly after its last word, never into the next one.
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i]!;
    const next = cues[i + 1];
    const limit = next ? next.start : Infinity;
    c.end = Math.min(limit, Math.max(c.end + 0.25, c.start + 0.5));
  }
  return cues;
}

export interface AssOptions {
  style: CaptionStyle;
  width: number;
  height: number;
  /** Accent colour for karaoke, #RRGGBB. */
  accent: string;
  /** Output ranges [start, end) where a `lower` graphic is on screen (captions move up). */
  lowerGraphics: Array<[number, number]>;
  /** Ranges with an `upper` graphic, which also block the raised position. */
  upperGraphics: Array<[number, number]>;
}

/** #RRGGBB to ASS &HAABBGGRR. alpha 0 is opaque. */
export function assColor(hex: string, alpha = 0): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  const [r, g, b] = m ? [m[1]!, m[2]!, m[3]!] : ['FF', 'FF', 'FF'];
  const a = Math.max(0, Math.min(255, Math.round(alpha))).toString(16).padStart(2, '0');
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

export function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

function sanitize(text: string): string {
  return text.replace(/[{}\\]/g, '').replace(/\s+/g, ' ');
}

/** Splits words into one or two balanced lines. */
function lineBreakIndex(texts: string[], maxLineChars: number): number {
  const total = texts.join(' ').length;
  if (total <= maxLineChars || texts.length < 2) return -1;
  let best = -1;
  let bestScore = Infinity;
  for (let k = 1; k < texts.length; k++) {
    const a = texts.slice(0, k).join(' ').length;
    const b = texts.slice(k).join(' ').length;
    const score = Math.abs(a - b) + (a < b ? 0 : 0.5); // slight preference for a shorter top line
    if (score < bestScore) {
      bestScore = score;
      best = k;
    }
  }
  return best;
}

interface StyleSpec {
  name: string;
  font: string;
  size: number;
  bold: boolean;
  primary: string;
  outlineColour: string;
  backColour: string;
  outline: number;
  shadow: number;
  spacing: number;
  prefix: string;
  uppercase: boolean;
  maxLineChars: number;
}

function styleSpec(o: AssOptions): StyleSpec {
  const k = o.width / 1080;
  switch (o.style) {
    case 'clean':
      return {
        name: 'Clean',
        font: 'Inter SemiBold',
        size: Math.round(64 * k),
        bold: false,
        primary: assColor('#FFFFFF'),
        outlineColour: assColor('#000000', 150),
        backColour: assColor('#000000', 140),
        outline: Math.max(1, Math.round(2 * k)),
        shadow: Math.max(1, Math.round(3 * k)),
        spacing: 0,
        prefix: `{\\blur${Math.max(1, Math.round(4 * k))}}`,
        uppercase: false,
        maxLineChars: 20,
      };
    case 'bold':
      return {
        name: 'Bold',
        font: 'Inter Black',
        size: Math.round(96 * k),
        bold: false,
        primary: assColor('#FFFFFF'),
        outlineColour: assColor('#000000'),
        backColour: assColor('#000000', 110),
        outline: Math.max(2, Math.round(7 * k)),
        shadow: Math.max(1, Math.round(4 * k)),
        spacing: 0,
        prefix: '',
        uppercase: true,
        maxLineChars: 12,
      };
    case 'karaoke':
      return {
        name: 'Karaoke',
        font: 'Inter ExtraBold',
        size: Math.round(72 * k),
        bold: false,
        primary: assColor('#FFFFFF'),
        outlineColour: assColor('#000000'),
        backColour: assColor('#000000', 120),
        outline: Math.max(2, Math.round(5 * k)),
        shadow: Math.max(1, Math.round(3 * k)),
        spacing: 0,
        prefix: '',
        uppercase: false,
        maxLineChars: 18,
      };
  }
}

const overlaps = (a0: number, a1: number, ranges: Array<[number, number]>) => ranges.some(([b0, b1]) => a0 < b1 && b0 < a1);

/** Bottom edge of the caption block, as a fraction of the frame height. Inside TikTok/Reels safe areas. */
export const CAPTION_BASELINE = 0.7;
/** Bottom edge when a lower graphic is on screen. */
export const CAPTION_RAISED_BASELINE = 0.47;

/** Builds an ASS subtitle script for the cues. Times are output seconds minus `shift`, clipped to [0, length]. */
export function buildAss(cues: Cue[], o: AssOptions, shift = 0, length = Infinity): string {
  const s = styleSpec(o);
  const marginSide = Math.round(o.width * 0.12);
  const marginV = Math.round(o.height * (1 - CAPTION_BASELINE));
  const lines: string[] = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${o.width}`,
    `PlayResY: ${o.height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: ${s.name},${s.font},${s.size},${s.primary},${s.primary},${s.outlineColour},${s.backColour},${s.bold ? -1 : 0},0,0,0,100,100,${s.spacing},0,1,${s.outline},${s.shadow},2,${marginSide},${marginSide},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const accent = assColor(o.accent);
  const event = (start: number, end: number, text: string, raised: boolean) => {
    const a = Math.max(0, start - shift);
    const b = Math.min(length, end - shift);
    if (b - a < 0.01) return;
    const pos = raised ? `{\\an2\\pos(${Math.round(o.width / 2)},${Math.round(o.height * CAPTION_RAISED_BASELINE)})}` : '';
    lines.push(`Dialogue: 0,${assTime(a)},${assTime(b)},${s.name},,0,0,0,,${pos}${s.prefix}${text}`);
  };
  for (const cue of cues) {
    if (cue.end - shift <= 0 || cue.start - shift >= length) continue;
    const raised = overlaps(cue.start, cue.end, o.lowerGraphics) && !overlaps(cue.start, cue.end, o.upperGraphics);
    const texts = cue.words.map((w) => {
      const t = sanitize(w.text);
      return s.uppercase ? t.toUpperCase() : t;
    });
    const br = lineBreakIndex(texts, s.maxLineChars);
    const render = (highlight: number) =>
      texts
        .map((t, i) => {
          const word = i === highlight ? `{\\1c${accent}}${t}{\\1c${s.primary}}` : t;
          return (i === br ? '\\N' : i === 0 ? '' : ' ') + word;
        })
        .join('');
    if (o.style === 'karaoke') {
      // One event per word: the word being spoken is in the accent colour.
      for (let i = 0; i < cue.words.length; i++) {
        const w = cue.words[i]!;
        const start = i === 0 ? cue.start : w.start;
        const next = cue.words[i + 1];
        const end = next ? next.start : cue.end;
        event(start, end, render(i), raised);
      }
    } else {
      event(cue.start, cue.end, render(-1), raised);
    }
  }
  return lines.join('\n') + '\n';
}

/** Graphic ranges by placement, in output seconds. */
export function graphicRanges(overlays: PlanOverlay[], fps: number, placement: 'lower' | 'upper'): Array<[number, number]> {
  return overlays
    .filter((o) => o.kind === 'graphic' && o.placement === placement)
    .map((o) => [o.frameStart / fps, (o.frameStart + o.frames) / fps] as [number, number]);
}
