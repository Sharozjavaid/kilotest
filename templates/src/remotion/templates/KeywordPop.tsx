import React, { useMemo } from 'react';
import type { TemplateComponentProps } from '../common';
import { fitFlow, fontCss, inkBox, unitOf } from '../fit';
import { ease, progress } from '../motion';
import { textDirection } from '../scripts';
import { cardShadow, fonts, inkOn } from '../style';

export interface KeywordPopProps {
  words: string[];
}

const PAD_X = 0.3;
const CHIP_H = 1.26;
const GAP = 0.16;
const ROW_GAP = 0.22;
const TILTS = [-2.5, 2, -1.5, 2.5];

/**
 * How far to move a word so its ink sits in the middle of a chip `chip` high (at 1px). The
 * line box places the baseline by the first family's ascent and descent; a word drawn by a
 * fallback face with deeper descenders would otherwise sit low.
 */
function inkShift(b: ReturnType<typeof inkBox>, chip: number): number {
  if (!b.fontAscent && !b.fontDescent) return -0.02;
  const baseline = (chip - (b.fontAscent + b.fontDescent)) / 2 + b.fontAscent;
  return chip / 2 - (baseline + (b.descent - b.ascent) / 2);
}

export const KeywordPop: React.FC<TemplateComponentProps<KeywordPopProps>> = ({ props, theme, clock, area }) => {
  const font = fonts(theme).headline;
  // Inset so tilted corners and the soft shadow also stay out of the right-hand rail.
  const inset = 22;
  const maxWidth = area.rightLower - area.left - inset * 2;
  const words = props.words.map((w) => w.trim());
  const L = useMemo(() => {
    const unit = words.map((w) => unitOf(w, font) + PAD_X * 2);
    // A chip is tall enough for its word's ink (Arabic and Devanagari reach further than Latin).
    const inks = words.map((w) => inkBox(w, font));
    const chip = Math.max(CHIP_H, ...inks.map((b) => b.ascent + b.descent + 0.36));
    const opts = { unit, gapUnit: GAP, maxWidth, lineUnit: chip, rowGapUnit: ROW_GAP, maxHeight: area.bottom - 24 - area.height * 0.5, maxLines: 4 };
    const fit = fitFlow({ ...opts, maxSize: 150, minSize: 52 }) ?? fitFlow({ ...opts, maxSize: 52, minSize: 20 });
    if (!fit) throw new Error('keyword-pop: words do not fit');
    return { fit, unit, inks, chip };
  }, [words.join('\u0000'), font.family, maxWidth, area.bottom, area.height]);

  const { fit, unit, inks, chip } = L;
  const size = fit.size;
  const chipH = size * chip;
  const rowGap = size * ROW_GAP;
  const blockH = fit.lines.length * chipH + (fit.lines.length - 1) * rowGap;
  const cx = (area.left + area.rightLower) / 2;
  const centerY = area.height * 0.68;
  const top = Math.max(area.height * 0.5, Math.min(centerY - blockH / 2, area.bottom - 24 - blockH));

  const n = words.length;
  const k = clock.k;
  const stagger = n > 1 ? Math.min(0.17, (clock.duration * 0.42) / n) : 0;
  const popDur = 0.34 * k;
  const outDur = Math.min(0.18 * k, clock.end * 0.25);
  const outStagger = Math.min(0.03, outDur * 0.2);
  const emphasis = n - 1;
  const accentInk = inkOn(theme, theme.accent);
  // Right-to-left words are read from the right: the first chip of a row goes at its right end.
  const rtl = textDirection(words.join(' ')) === 'rtl';
  const shadow = cardShadow(theme);

  return (
    <>
      {fit.lines.map((line, li) => {
        const lineW = fit.lineWidths[li]!;
        let x = cx - lineW / 2;
        const y = top + li * (chipH + rowGap);
        return line.map((i) => {
          const w = unit[i]! * size;
          const left = rtl ? 2 * cx - x - w : x;
          x += w + GAP * size;
          const p = progress(clock.t, i * stagger, popDur);
          const outStart = clock.end - outDur - (n - 1 - i) * outStagger;
          const po = ease.inCubic(progress(clock.t, outStart, outDur));
          const scale = (0.25 + 0.75 * ease.outBack(p, 2.6)) * (1 - 0.35 * po);
          const opacity = Math.min(1, p * 5) * (1 - po);
          const dy = (1 - ease.outCubic(p)) * size * 0.35 + po * size * 0.12;
          // Long chips tilt less, so their corners never reach the row above or below.
          const tiltMax = Math.min(1, (size * 3.2) / w);
          const tilt = TILTS[i % TILTS.length]! * tiltMax * (0.6 + 0.4 * ease.outCubic(p));
          const hot = i === emphasis;
          return (
            <div
              key={i}
              data-probe-line={`row-${li}`}
              style={{
                position: 'absolute',
                left,
                top: y,
                width: w,
                height: chipH,
                borderRadius: size * 0.24,
                background: hot ? theme.accent : theme.background,
                color: hot ? accentInk : theme.foreground,
                boxShadow: shadow,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transform: `translateY(${dy}px) rotate(${tilt}deg) scale(${Math.max(0, scale)})`,
                opacity,
              }}
            >
              <span style={{ ...fontCss(font, size), lineHeight: `${chipH}px`, transform: `translateY(${inkShift(inks[i]!, chip) * size}px)` }}>{words[i]}</span>
            </div>
          );
        });
      })}
    </>
  );
};
