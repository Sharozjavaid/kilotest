import type { Word } from '@kilo/edl';

/** Text helpers shared by the transcribers, the deciders and the placement passes. */

/** Words that are always fillers when spoken on their own. */
export const FILLER_WORDS = new Set([
  'um', 'umm', 'ummm', 'uh', 'uhh', 'uhm', 'uhhm', 'er', 'erm', 'err', 'ah', 'ahh', 'eh', 'hmm', 'hm', 'mm', 'mmm', 'mhm',
]);

/** Words that are fillers only when set off by commas, as in "it's, like, huge". */
export const SOFT_FILLERS = new Set(['like', 'basically', 'literally', 'actually']);
export const SOFT_FILLER_PHRASES = [['you', 'know'], ['i', 'mean']];

/** Lowercase, strip punctuation and quotes; keeps inner apostrophes. */
export function norm(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9'%$.]+/g, ' ')
    .replace(/(^|\s)'+|'+(\s|$)/g, ' ')
    .replace(/\.(?!\d)/g, ' ')
    .trim();
}

const CONTRACTIONS: Record<string, string> = {
  "it's": 'it', "i've": 'i', "i'm": 'i', "i'll": 'i', "i'd": 'i', "you're": 'you', "you've": 'you', "you'll": 'you',
  "we're": 'we', "we've": 'we', "they're": 'they', "that's": 'that', "there's": 'there', "here's": 'here',
  "what's": 'what', "don't": 'do', "doesn't": 'does', "didn't": 'did', "can't": 'can', "won't": 'will',
  "isn't": 'is', "let's": 'let', "link's": 'link',
};

/** A comparison key for one token: lowercased, contractions folded, plural s dropped. */
export function key(token: string): string {
  const t = norm(token).replace(/\s+/g, '');
  if (CONTRACTIONS[t]) return CONTRACTIONS[t]!;
  const base = t.replace(/'s$/, '');
  if (base.length > 4 && base.endsWith('s') && !base.endsWith('ss')) return base.slice(0, -1);
  return base;
}

export function tokens(text: string): string[] {
  return norm(text).split(/\s+/).filter(Boolean);
}

export function keys(text: string): string[] {
  return tokens(text).map(key).filter(Boolean);
}

export function endsSentence(text: string): boolean {
  return /[.!?…]["')\]]*$/.test(text.trim());
}

export function endsClause(text: string): boolean {
  return /[,;:—–-]["')\]]*$/.test(text.trim());
}

export function hasPunctuation(words: readonly Word[]): boolean {
  return words.some((w) => /[.,!?;:]/.test(w.text));
}

/** Flags filler words with the lexicon. Never unflags what a provider already flagged. */
export function flagFillers(words: Word[]): Word[] {
  return words.map((w, i) => {
    if (w.filler) return w;
    const k = norm(w.text).replace(/\s+/g, '');
    if (FILLER_WORDS.has(k)) return { ...w, filler: true };
    const prev = words[i - 1];
    const setOffBefore = !prev || endsClause(prev.text) || endsSentence(prev.text);
    if (SOFT_FILLERS.has(k) && setOffBefore && endsClause(w.text)) return { ...w, filler: true };
    for (const phrase of SOFT_FILLER_PHRASES) {
      const next = words[i + 1];
      if (k === phrase[0] && next && norm(next.text).replace(/\s+/g, '') === phrase[1] && setOffBefore && endsClause(next.text)) {
        return { ...w, filler: true };
      }
      if (k === phrase[1] && prev && norm(prev.text).replace(/\s+/g, '') === phrase[0] && endsClause(w.text)) {
        const pp = words[i - 2];
        if (!pp || endsClause(pp.text) || endsSentence(pp.text)) return { ...w, filler: true };
      }
    }
    return w;
  });
}

/** Longest common subsequence length of two token lists. */
export function lcs(a: readonly string[], b: readonly string[]): number {
  if (!a.length || !b.length) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** Share of both lists that align: LCS over the longer length. */
export function fullSimilarity(a: readonly string[], b: readonly string[]): number {
  const n = Math.max(a.length, b.length);
  return n ? lcs(a, b) / n : 0;
}

/** How well the shorter list matches the start of the longer one. */
export function prefixSimilarity(a: readonly string[], b: readonly string[]): number {
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (!s.length) return 0;
  return lcs(s, l.slice(0, s.length + 2)) / s.length;
}

/** F1 of a spoken token list against a script line. */
export function lineMatch(spoken: readonly string[], line: readonly string[]): { f1: number; coverage: number; precision: number } {
  if (!spoken.length || !line.length) return { f1: 0, coverage: 0, precision: 0 };
  const common = lcs(spoken, line);
  const coverage = common / line.length;
  const precision = common / spoken.length;
  const f1 = coverage + precision ? (2 * coverage * precision) / (coverage + precision) : 0;
  return { f1, coverage, precision };
}

// ---- numbers ---------------------------------------------------------------

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, million: 1_000_000 };
export const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  firstly: 1, secondly: 2, thirdly: 3,
};

export interface NumberToken {
  value: number;
  /** Index of the first and one past the last token used. */
  from: number;
  to: number;
}

/** Reads a number at `i` in `toks` (normalised tokens): "12", "$12", "twelve", "thirty four", "1.5". */
export function readNumber(toks: readonly string[], i: number): NumberToken | null {
  const t = toks[i];
  if (t === undefined) return null;
  const digits = t.replace(/^\$/, '').replace(/%$/, '').replace(/,/g, '');
  if (/^\d+(\.\d+)?$/.test(digits)) return { value: Number(digits), from: i, to: i + 1 };
  if (!(t in UNITS)) return null;
  let total = 0;
  let current = 0;
  let j = i;
  let lastWasTens = false;
  while (j < toks.length) {
    const w = toks[j]!;
    if (w in UNITS) {
      const v = UNITS[w]!;
      if (current > 0 && v >= 10 && !(current % 100 === 0)) break; // "twelve twenty" is two numbers
      if (lastWasTens && v >= 10) break;
      current += v;
      lastWasTens = v >= 20 && v % 10 === 0;
      j++;
    } else if (w in SCALES && current > 0) {
      const s = SCALES[w]!;
      if (s === 100) current *= 100;
      else {
        total += current * s;
        current = 0;
      }
      lastWasTens = false;
      j++;
    } else if (w === 'and' && current >= 100 && toks[j + 1] && toks[j + 1]! in UNITS) {
      j++;
    } else break;
  }
  return { value: total + current, from: i, to: j };
}

export function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** Clean display text from a word run: trims trailing punctuation that reads oddly in a graphic. */
export function displayText(words: readonly string[]): string {
  return words.join(' ').replace(/\s+/g, ' ').replace(/[,;:]+$/, '').trim();
}

/** Shortens text to at most `max` characters on a word boundary. */
export function clampWords(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const words = clean.split(' ');
  let out = '';
  for (const w of words) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > max) break;
    out = next;
  }
  if (!out) out = clean.slice(0, max);
  out = out.replace(/[,;:]+$/, '');
  // Never end on a word that leaves the phrase hanging ("folds flat into").
  const DANGLE = /\s+(and|or|but|so|the|a|an|to|of|with|for|in|on|at|by|from|into|onto|about|my|your|our|their|this|that|is|are|was|were|it|its|be|than|as|if)$/i;
  while (DANGLE.test(out) && out.split(' ').length > 2) out = out.replace(DANGLE, '').replace(/[,;:]+$/, '');
  return out;
}

export const STOPWORDS = new Set(
  ('a an the and or but so if then of to in on at for with from by is are was were be been being am do does did ' +
    'it this that these those there here i me my we our you your he she they them his her its their what which who ' +
    'how when where why not no yes just really very can will would should could have has had get got go going ' +
    'about up out over into than too also only even some any all one okay ok well like know want try use used ' +
    'make makes thing things way lot s re ve ll d t').split(' '),
);

/** Light stemming for keyword matching. */
export function stem(word: string): string {
  let w = key(word);
  for (const suf of ['ing', 'ed', 'es', 'ly', 's']) {
    if (w.length > suf.length + 3 && w.endsWith(suf)) {
      w = w.slice(0, -suf.length);
      break;
    }
  }
  return w;
}

export function contentStems(text: string): string[] {
  return tokens(text)
    .filter((t) => !STOPWORDS.has(key(t)) && !/^\d+$/.test(t) && t.length > 1)
    .map(stem);
}
