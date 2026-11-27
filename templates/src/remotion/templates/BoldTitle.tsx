import React, { useMemo } from 'react';
import type { TemplateComponentProps } from '../common';
import { Plate, plateMotion } from '../common';
import { fitText, fontCss } from '../fit';
import { ease, progress } from '../motion';
import { textDirection } from '../scripts';
import { DESIGN_WIDTH, fonts } from '../style';

export interface BoldTitleProps {
  text: string;
}

const LINE = 1.04;
const INK_MARGIN = 16;

export const BoldTitle: React.FC<TemplateComponentProps<BoldTitleProps>> = ({ props, theme, clock, area }) => {
  const font = fonts(theme).headline;
  // Centred on the frame, narrow enough that lines in the lower half clear the right-hand rail.
  // Fitting measures advance widths; heavy glyphs' ink overhangs them slightly, so keep a margin.
  const maxWidth = 2 * (area.rightLower - DESIGN_WIDTH / 2 - INK_MARGIN);
  const left = DESIGN_WIDTH / 2 - maxWidth / 2;
  const fit = useMemo(
    () =>
      fitText(props.text, {
        font,
        maxWidth,
        maxHeight: (area.bottom - area.top) * 0.78,
        lineHeight: LINE,
        maxLines: 7,
        maxSize: 280,
        minSize: 72,
      }),
    [props.text, font.family, maxWidth, area.bottom, area.top],
  );

  const words = fit.lines.flat();
  const accentIndex = words.length >= 2 ? words.length - 1 : -1;
  const k = clock.k;
  const start = plateMotion(clock, area.height).contentStart;
  const stagger = Math.min(0.055, 0.34 / Math.max(1, words.length)) * k;
  const wordDur = 0.42 * k;
  const lastLand = start + stagger * (words.length - 1) + wordDur * 0.6;

  const size = fit.size;
  const blockH = fit.lines.length * size * fit.line;
  const barH = Math.max(10, Math.round(size * 0.085));
  const barW = Math.min(150, Math.max(90, size * 0.9));
  const barGap = size * 0.3;
  const totalH = blockH + barGap + barH;
  const top = (area.top + area.bottom) / 2 - totalH / 2;
  const bar = ease.outExpo(progress(clock.t, lastLand - 0.05 * k, 0.4 * k));

  let w = 0;
  return (
    <Plate clock={clock} theme={theme} height={area.height}>
      <div style={{ position: 'absolute', left, width: maxWidth, top, textAlign: 'center' }}>
        {fit.lines.map((line, li) => (
          // Each word is its own inline block, which the browser's bidi reordering cannot see
          // into: the line's direction is set from its text, so right-to-left words run right to left.
          <div
            key={li}
            data-probe-line={`title-${li}`}
            style={{
              ...fontCss(font, size), lineHeight: `${size * fit.line}px`, height: size * fit.line, color: theme.foreground,
              direction: textDirection(line.join(' ')), unicodeBidi: 'isolate',
            }}
          >
            {line.map((word, wi) => {
              const i = w++;
              const p = progress(clock.t, start + i * stagger, wordDur);
              const y = (1 - ease.outBack(p, 1.3)) * size * 0.42;
              const o = ease.outCubic(Math.min(1, p * 2.4));
              const s = 0.9 + 0.1 * ease.outCubic(p);
              return (
                <React.Fragment key={wi}>
                  {wi > 0 ? ' ' : null}
                  <span
                    style={{
                      display: 'inline-block',
                      transform: `translateY(${y}px) scale(${s})`,
                      opacity: o,
                      color: i === accentIndex ? theme.accent : theme.foreground,
                    }}
                  >
                    {word}
                  </span>
                </React.Fragment>
              );
            })}
          </div>
        ))}
        <div
          style={{
            margin: `${barGap}px auto 0`,
            width: barW,
            height: barH,
            borderRadius: barH / 2,
            background: theme.accent,
            transform: `scaleX(${bar})`,
          }}
        />
      </div>
    </Plate>
  );
};
