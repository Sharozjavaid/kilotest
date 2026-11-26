import React, { useMemo } from 'react';
import { cardEnvelope } from '../card';
import type { TemplateComponentProps } from '../common';
import { fitText, fontCss, measure, unitOf } from '../fit';
import { alpha, cardShadow, fonts, inkOn } from '../style';
import { ease, progress } from '../motion';

export interface PriceTagProps {
  price: string;
  compareAt?: string;
  label?: string;
}

const COMPARE_RATIO = 0.42;
const ROW_GAP = 0.16;

export const PriceTag: React.FC<TemplateComponentProps<PriceTagProps>> = ({ props, theme, clock, area }) => {
  const f = fonts(theme);
  const padX = 60;
  const maxInner = area.rightUpper - area.left - padX * 2;
  const compareAt = props.compareAt?.trim() || '';
  const label = props.label?.trim() || '';

  const L = useMemo(() => {
    const uP = unitOf(props.price, f.heavy);
    const uC = compareAt ? unitOf(compareAt, f.display) : 0;
    let row = false;
    let size: number;
    if (compareAt) {
      const sRow = Math.floor(Math.min(230, maxInner / (uP + COMPARE_RATIO * uC + ROW_GAP)));
      if (sRow >= 150) {
        row = true;
        size = sRow;
      } else {
        size = Math.floor(Math.min(230, maxInner / uP));
      }
    } else {
      size = Math.floor(Math.min(230, maxInner / uP));
    }
    size = Math.max(size, 40);
    let compareSize = Math.round(size * COMPARE_RATIO);
    if (!row && compareAt) compareSize = Math.max(40, Math.min(Math.round(size * 0.5), Math.floor(maxInner / uC)));
    const priceW = measure(props.price, f.heavy, size);
    const compareW = compareAt ? measure(compareAt, f.display, compareSize) : 0;
    const labelFit = label
      ? fitText(label, { font: f.label, maxWidth: maxInner - 64, maxHeight: 200, lineHeight: 1.15, maxLines: 2, maxSize: 50, minSize: 30 })
      : null;
    const contentW = row ? priceW + compareW + ROW_GAP * size : Math.max(priceW, compareW);
    const labelW = labelFit ? Math.max(...labelFit.lineWidths) + labelFit.size * 1.4 : 0;
    const inner = Math.max(contentW, labelW, 380);
    return { row, size, compareSize, priceW, compareW, labelFit, inner };
  }, [props.price, compareAt, label, f.heavy.family, maxInner]);

  const k = clock.k;
  const env = cardEnvelope(clock);
  const labelP = progress(clock.t, 0.12 * k, 0.34 * k);
  const compareP = progress(clock.t, 0.14 * k, 0.32 * k);
  const strikeP = ease.inOutCubic(progress(clock.t, 0.36 * k, 0.24 * k));
  const priceStart = compareAt ? 0.56 * k : 0.14 * k;
  const priceP = progress(clock.t, priceStart, 0.4 * k);
  const priceScale = 1.45 - 0.45 * ease.outBack(priceP, 1.9);
  const priceO = Math.min(1, priceP * 5);

  const cardW = L.inner + padX * 2;
  const cx = (area.left + area.rightUpper) / 2;
  const muted = alpha(theme.foreground, 0.5);
  const cs = L.compareSize;
  const strikeH = Math.max(6, Math.round(cs * 0.1));
  // A shallow diagonal: steep on a short price, flatter on a long one so it never crosses the neighbours.
  const strikeAngle = -Math.min(9, (Math.atan((cs * 0.32) / Math.max(1, L.compareW)) * 180) / Math.PI);
  const lf = L.labelFit;

  const compareEl = compareAt ? (
    <div
      style={{
        position: 'relative',
        display: 'inline-block',
        color: muted,
        opacity: ease.outCubic(Math.min(1, compareP * 2)),
        transform: `translateY(${(1 - ease.outQuart(compareP)) * 18}px)`,
      }}
    >
      <span style={{ ...fontCss(f.display, cs), lineHeight: `${cs * 1.1}px` }}>{compareAt}</span>
      <div
        style={{
          position: 'absolute',
          left: '-5%',
          width: '110%',
          top: `calc(52% - ${strikeH / 2}px)`,
          height: strikeH,
          borderRadius: strikeH / 2,
          background: theme.accent,
          transformOrigin: '0 50%',
          transform: `rotate(${strikeAngle}deg) scaleX(${strikeP})`,
        }}
      />
    </div>
  ) : null;

  const priceEl = (
    <div
      style={{
        display: 'inline-block',
        color: theme.accent,
        opacity: priceO,
        transform: `scale(${priceScale}) translateY(${(1 - ease.outCubic(priceP)) * -L.size * 0.12}px)`,
        transformOrigin: '50% 60%',
      }}
    >
      <span style={{ ...fontCss(f.heavy, L.size), lineHeight: `${L.size}px` }}>{props.price}</span>
    </div>
  );

  return (
    <div
      style={{
        position: 'absolute',
        left: cx - cardW / 2,
        top: area.top + 36,
        width: cardW,
        padding: `${lf ? 40 : Math.round(L.size * 0.16 + 26)}px ${padX}px ${Math.round(L.size * 0.16 + 30)}px`,
        boxSizing: 'border-box',
        borderRadius: 44,
        background: theme.background,
        boxShadow: cardShadow(theme),
        textAlign: 'center',
        transformOrigin: '50% 30%',
        transform: `translateY(${env.y}px) scale(${env.scale})`,
        opacity: env.opacity,
      }}
    >
      {lf ? (
        <div
          style={{
            display: 'inline-block',
            padding: `${lf.size * 0.34}px ${lf.size * 0.7}px`,
            borderRadius: lf.size,
            background: theme.accent,
            color: inkOn(theme, theme.accent),
            marginBottom: Math.round(L.size * 0.12 + 16),
            transform: `scale(${Math.max(0, ease.outBack(labelP, 2.2))})`,
            opacity: Math.min(1, labelP * 4),
          }}
        >
          {lf.lines.map((line, i) => (
            <div key={i} style={{ ...fontCss(f.label, lf.size), lineHeight: `${lf.size * 1.15}px` }}>
              {line.join(' ')}
            </div>
          ))}
        </div>
      ) : null}
      {L.row ? (
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: L.size * ROW_GAP }}>
          {compareEl}
          {priceEl}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: Math.round(L.size * 0.04) }}>
          {compareEl}
          {priceEl}
        </div>
      )}
    </div>
  );
};
