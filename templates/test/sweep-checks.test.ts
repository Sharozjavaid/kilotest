import { describe, expect, it } from 'vitest';
import { checkProbe } from '../scripts/sweep.js';
import type { ProbeResult, ProbeText } from '../src/remotion/probe.js';
import { cjkOrder, textDirection } from '../src/remotion/scripts.js';

/** One text drawn at a safe place, one grapheme per 60 px from `x0` going right (or left). */
function text(t: string, x0: number, opts: { rtl?: boolean; face?: string | null; line?: string } = {}): ProbeText {
  const gs = [...t].filter((c) => c.trim());
  const glyphs = gs.map((_, i) => {
    const left = opts.rtl ? x0 - (i + 1) * 60 : x0 + i * 60;
    return { left, right: left + 50, top: 800, bottom: 860 };
  });
  const ink = { left: Math.min(...glyphs.map((g) => g.left)), right: Math.max(...glyphs.map((g) => g.right)), top: 800, bottom: 860 };
  return {
    id: 0, text: t, sizePx: 80, ink, container: null, clips: [], tofu: [], ancestors: [], glyphs, glyphText: gs, fontFamily: '"Kilo Inter"',
    faces: Object.fromEntries(gs.map((g) => [g, opts.face === undefined ? 'Kilo Hebrew' : opts.face])), direction: 'ltr', line: opts.line ?? null,
  };
}
const probe = (texts: ProbeText[]): ProbeResult => ({ width: 1080, height: 1920, texts: texts.map((t, id) => ({ ...t, id })), boxes: [] });
const CASE = { kind: 'Hebrew', covered: false, props: {} };

describe('sweep checks for bundled faces and right-to-left text', () => {
  it('accepts Hebrew drawn right to left by the bundled face', () => {
    expect(checkProbe(probe([text('שלום', 700, { rtl: true })]), CASE).problems).toEqual([]);
  });
  it('flags right-to-left letters drawn left to right', () => {
    expect(checkProbe(probe([text('שלום', 200)]), CASE).problems.join()).toMatch(/drawn left to right/);
  });
  it('flags words of one line laid out in the wrong order', () => {
    const p = probe([text('זה', 300, { rtl: true, line: 'title-0' }), text('עובד', 700, { rtl: true, line: 'title-0' })]);
    expect(checkProbe(p, CASE).problems.join()).toMatch(/drawn to its right/);
  });
  it('flags a grapheme a machine font drew', () => {
    expect(checkProbe(probe([text('שלום', 700, { rtl: true, face: 'DejaVu Sans' })]), CASE).problems.join()).toMatch(/not a bundled one/);
    expect(checkProbe(probe([text('שלום', 700, { rtl: true, face: null })]), CASE).problems.join()).toMatch(/outside the font stack/);
  });
  it('reads direction and the CJK order from the text', () => {
    expect(textDirection('مرحبا world')).toBe('rtl');
    expect(textDirection('90% מהאנשים')).toBe('rtl');
    expect(textDirection('Hi שלום')).toBe('ltr');
    expect(cjkOrder('この化粧水')[0]).toBe('Kilo JP');
    expect(cjkOrder('세럼')[0]).toBe('Kilo KR');
    expect(cjkOrder('这款精华')[0]).toBe('Kilo SC');
  });
});
