import React, { useMemo } from 'react';
import type { TemplateComponentProps } from '../common';
import { fitFlow, fontCss, unitOf } from '../fit';
import { ease, progress } from '../motion';
import { cardShadow, fonts, inkOn } from '../style';

export interface KeywordPopProps {
  words: string[];
}

const PAD_X = 0.3;
const CHIP_H = 1.26;
const GAP = 0.16;
const ROW_GAP = 0.22;
const TILTS = [-2.5, 2, -1.5, 2.5];

export const KeywordPop: React.FC<TemplateComponentProps<KeywordPopProps>> = ({ props, theme, clock, area }) => {
  const font = fonts(theme).headline;
  // Inset so tilted corners and the soft shadow also stay out of the right-hand rail.
  const inset = 22;
  const maxWidth = area.rightLower - area.left - inset * 2;
  const words = props.words.map((w) => w.trim());
  const L = useMemo(() => {
    const unit = words.map((w) => unitOf(w, font) + PAD_X * 2);
    const opts = { unit, gapUnit: GAP, maxWidth, lineUnit: CHIP_H, rowGapUnit: ROW_GAP, maxHeight: area.bottom - 24 - area.height * 0.5, maxLines: 4 };
    const fit = fitFlow({ ...opts, maxSize: 150, minSize: 52 }) ?? fitFlow({ ...opts, maxSize: 52, minSize: 20 });
    if (!fit) throw new Error('keyword-pop: words do not fit');
    return { fit, unit };
  }, [words.join('\u0000'), font.family, maxWidth, area.bottom, area.height]);

  const { fit, unit } = L;
  const size = fit.size;
  const chipH = size * CHIP_H;
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
  const shadow = cardShadow(theme);

  return (
    <>
      {fit.lines.map((line, li) => {
        const lineW = fit.lineWidths[li]!;
        let x = cx - lineW / 2;
        const y = top + li * (chipH + rowGap);
        return line.map((i) => {
          const w = unit[i]! * size;
          const left = x;
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
              <span style={{ ...fontCss(font, size), lineHeight: `${chipH}px`, transform: `translateY(${-size * 0.02}px)` }}>{words[i]}</span>
            </div>
          );
        });
      })}
    </>
  );
};
