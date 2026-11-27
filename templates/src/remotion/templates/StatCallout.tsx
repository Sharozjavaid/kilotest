import React, { useMemo } from 'react';
import type { TemplateComponentProps } from '../common';
import { fitText, fontCss, measure } from '../fit';
import { cardEnvelope } from '../card';
import { ease, progress } from '../motion';
import { cardShadow, fonts } from '../style';

export interface StatCalloutProps {
  value: string;
  label: string;
}

const LABEL_LINE = 1.16;

interface Counter {
  prefix: string;
  target: number;
  decimals: number;
  commas: boolean;
  suffix: string;
}

/** "$1,200", "10 sec", "3.5x": the number to count up to, and what surrounds it. */
export function parseCounter(value: string): Counter | null {
  const m = /^(\D*?)(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(.*)$/.exec(value);
  if (!m) return null;
  const num = m[2]!;
  const target = parseFloat(num.replace(/,/g, ''));
  if (!Number.isFinite(target) || target < 2) return null;
  const dot = num.indexOf('.');
  return { prefix: m[1]!, target, decimals: dot >= 0 ? num.length - dot - 1 : 0, commas: num.includes(','), suffix: m[3]! };
}

function formatCount(c: Counter, v: number): string {
  let s = v.toFixed(c.decimals);
  if (c.commas) {
    const [int, frac] = s.split('.');
    s = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? `.${frac}` : '');
  }
  return c.prefix + s + c.suffix;
}

export const StatCallout: React.FC<TemplateComponentProps<StatCalloutProps>> = ({ props, theme, clock, area }) => {
  const f = fonts(theme);
  const padX = 64;
  const maxInner = area.rightUpper - area.left - padX * 2;
  const L = useMemo(() => {
    const value = fitText(props.value, { font: f.heavy, maxWidth: maxInner, maxHeight: 400, lineHeight: 1, maxLines: 1, maxSize: 250, minSize: 72 });
    const labelMax = Math.max(46, Math.min(76, Math.round(value.size * 0.4)));
    const label = fitText(props.label, { font: f.bold, maxWidth: maxInner, maxHeight: 300, lineHeight: LABEL_LINE, maxLines: 3, maxSize: labelMax, minSize: 40 });
    const valueW = measure(props.value, f.heavy, value.size);
    const inner = Math.max(valueW, ...label.lineWidths, 400);
    return { value, label, valueW, inner };
  }, [props.value, props.label, f.heavy.family, maxInner]);

  const k = clock.k;
  const env = cardEnvelope(clock);
  const counter = parseCounter(props.value);
  const countP = ease.outExpo(progress(clock.t, 0.08 * k, 0.75 * k));
  const shown = counter && countP < 1 ? formatCount(counter, counter.target * countP) : props.value;
  const valueP = progress(clock.t, 0.04 * k, 0.4 * k);
  const labelP = progress(clock.t, 0.22 * k, 0.4 * k);

  const vs = L.value.size;
  const ls = L.label.size;
  const padTop = Math.round(vs * 0.12 + 40);
  const padBottom = Math.round(ls * 0.7 + 30);
  const cardW = L.inner + padX * 2;
  const cx = (area.left + area.rightUpper) / 2;

  return (
    <div
      style={{
        position: 'absolute',
        left: cx - cardW / 2,
        top: area.top + 36,
        width: cardW,
        padding: `${padTop}px ${padX}px ${padBottom}px`,
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
      <div
        style={{
          ...fontCss(f.heavy, vs),
          lineHeight: `${vs * 1.0}px`,
          height: vs,
          color: theme.accent,
          transform: `scale(${0.86 + 0.14 * ease.outBack(valueP, 1.6)})`,
        }}
      >
        {shown}
      </div>
      <div
        style={{
          marginTop: Math.round(vs * 0.1 + 6),
          color: theme.foreground,
          opacity: ease.outCubic(Math.min(1, labelP * 1.8)),
          transform: `translateY(${(1 - ease.outQuart(labelP)) * 22}px)`,
        }}
      >
        {L.label.lines.map((line, i) => (
          <div key={i} style={{ ...fontCss(f.bold, ls), lineHeight: `${ls * L.label.line}px` }}>
            {line.join(' ')}
          </div>
        ))}
      </div>
    </div>
  );
};
