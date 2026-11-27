import React, { useMemo } from 'react';
import type { TemplateComponentProps } from '../common';
import { Plate, plateMotion } from '../common';
import type { FontSpec } from '../fit';
import { fitFlow, fitText, fontCss, unitOf } from '../fit';
import { ease, progress } from '../motion';
import { textDirection } from '../scripts';
import { fonts, inkOn } from '../style';

export interface NumberedListProps {
  title?: string;
  items: string[];
}

const ITEM_LINE = 1.12;
const TITLE_LINE = 1.04;
/** The badge digit is 0.58 of the badge: never under the readable 36 px. */
const MIN_BADGE = 64;

interface ItemLayout {
  size: number;
  lines: string[][];
}

/** Wraps `text` at exactly `size` into at most `maxLines` balanced lines, or null. */
function wrapAt(text: string, font: FontSpec, size: number, maxWidth: number, maxLines: number): string[][] | null {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const flow = fitFlow({
    unit: words.map((w) => unitOf(w, font)),
    gapUnit: unitOf(' ', font),
    maxWidth,
    lineUnit: ITEM_LINE,
    maxHeight: Infinity,
    maxLines,
    maxSize: size,
    minSize: size,
  });
  return flow ? flow.lines.map((ix) => ix.map((i) => words[i]!)) : null;
}

function layout(p: NumberedListProps, f: ReturnType<typeof fonts>, width: number, height: number) {
  const titleFont = f.headline;
  const itemFont = f.display;
  const hasTitle = !!p.title && p.title.trim().length > 0;

  // Prefer every item on one line at a generous size; allow two lines only when that would be too small.
  const passes: Array<[maxLines: number, minSize: number]> = [[1, 66], [2, 38]];
  for (const [itemLines, minSize] of passes)
  for (let size = 124; size >= minSize; size--) {
    const badge = Math.max(MIN_BADGE, Math.round(size * 1.34));
    const gap = Math.round(size * 0.42);
    const col = width - badge - gap;
    const items: ItemLayout[] = [];
    let ok = true;
    for (const it of p.items) {
      const lines = wrapAt(it, itemFont, size, col, itemLines);
      if (!lines) {
        ok = false;
        break;
      }
      items.push({ size, lines });
    }
    if (!ok) continue;
    const rowGap = size * 0.62;
    const rowsH = items.reduce((a, it) => a + Math.max(badge, it.lines.length * size * ITEM_LINE), 0) + rowGap * (items.length - 1);
    let title = null as null | { size: number; lines: string[][]; line: number };
    let titleH = 0;
    if (hasTitle) {
      // One line when it can stay clearly bigger than the items; otherwise two balanced lines.
      let one: { size: number; lines: string[][]; line: number } | null = null;
      for (let s = Math.min(150, Math.round(size * 1.55)); s >= Math.round(size * 1.2) && !one; s--) {
        const l = wrapAt(p.title!, titleFont, s, width, 1);
        if (l) one = { size: s, lines: l, line: TITLE_LINE };
      }
      const t = one ?? fitText(p.title!, {
        font: titleFont,
        maxWidth: width,
        maxHeight: height * 0.3,
        lineHeight: TITLE_LINE,
        maxLines: 2,
        maxSize: Math.min(150, Math.round(size * 1.55)),
        minSize: Math.min(size + 6, 56),
      });
      title = { size: t.size, lines: t.lines, line: t.line };
      titleH = t.lines.length * t.size * t.line + Math.max(48, t.size * 0.55);
    }
    if (rowsH + titleH <= height) return { size, badge, gap, col, items, rowGap, title, total: rowsH + titleH };
  }
  // Fallback for pathological input (very long single words): break words at a small size.
  const size = 38;
  const badge = Math.max(MIN_BADGE, Math.round(size * 1.34));
  const gap = Math.round(size * 0.42);
  const col = width - badge - gap;
  const items = p.items.map((it) => {
    const t = fitText(it, { font: itemFont, maxWidth: col, maxHeight: Infinity, lineHeight: ITEM_LINE, maxLines: 2, maxSize: size, minSize: size, floorSize: 26 });
    return { size: t.size, lines: t.lines };
  });
  const rowGap = size * 0.5;
  const rowsH = items.reduce((a, it) => a + Math.max(badge, it.lines.length * it.size * ITEM_LINE), 0) + rowGap * (items.length - 1);
  let title = null as null | { size: number; lines: string[][]; line: number };
  let titleH = 0;
  if (hasTitle) {
    const t = fitText(p.title!, { font: titleFont, maxWidth: width, maxHeight: height * 0.25, lineHeight: TITLE_LINE, maxLines: 2, maxSize: 64, minSize: 44 });
    title = { size: t.size, lines: t.lines, line: t.line };
    titleH = t.lines.length * t.size * t.line + 40;
  }
  return { size, badge, gap, col, items, rowGap, title, total: rowsH + titleH };
}

export const NumberedList: React.FC<TemplateComponentProps<NumberedListProps>> = ({ props, theme, clock, area }) => {
  const f = fonts(theme);
  const left = area.left + 8;
  const width = area.rightLower - left;
  const availH = area.bottom - area.top - 40;
  const L = useMemo(() => layout(props, f, width, availH), [props, f.headline.family, width, availH]);

  const k = clock.k;
  const start = plateMotion(clock, area.height).contentStart;
  const n = props.items.length;
  const firstItem = start + (L.title ? 0.2 * k : 0.02);
  const lastItem = Math.max(firstItem, Math.min(firstItem + (n - 1) * 0.5, clock.duration * 0.5));
  const spacing = n > 1 ? (lastItem - firstItem) / (n - 1) : 0;
  const top = area.top + 20 + (availH - L.total) / 2;
  const badgeInk = inkOn(theme, theme.accent);
  // A right-to-left list is mirrored: badges on the right, text running to their left.
  const rtl = textDirection([props.title ?? '', ...props.items].join(' ')) === 'rtl';
  const badgeLeft = rtl ? left + width - L.badge : left;
  const textLeft = rtl ? left + width - L.badge - L.gap - L.col : left + L.badge + L.gap;

  const titleP = progress(clock.t, start, 0.42 * k);
  let y = top;
  const titleEl = L.title ? (
    <div
      style={{
        position: 'absolute',
        left,
        top: y,
        width,
        color: theme.foreground,
        opacity: ease.outCubic(Math.min(1, titleP * 2)),
        transform: `translateY(${(1 - ease.outQuart(titleP)) * 40}px)`,
      }}
    >
      {L.title.lines.map((line, i) => (
        <div key={i} style={{ ...fontCss(f.headline, L.title!.size), lineHeight: `${L.title!.size * L.title!.line}px` }}>
          {line.join(' ')}
        </div>
      ))}
    </div>
  ) : null;
  if (L.title) y += L.title.lines.length * L.title.size * L.title.line + Math.max(48, L.title.size * 0.55);

  const rows = L.items.map((it, i) => {
    const textH = it.lines.length * it.size * ITEM_LINE;
    const rowH = Math.max(L.badge, textH);
    const rowTop = y;
    y += rowH + L.rowGap;
    const t0 = firstItem + i * spacing;
    const pb = progress(clock.t, t0, 0.34 * k);
    const pt = progress(clock.t, t0 + 0.05 * k, 0.4 * k);
    const badgeScale = ease.outBack(pb, 2.2);
    return (
      <React.Fragment key={i}>
        <div
          style={{
            position: 'absolute',
            left: badgeLeft,
            top: rowTop + (rowH - L.badge) / 2,
            width: L.badge,
            height: L.badge,
            borderRadius: L.badge * 0.3,
            background: theme.accent,
            color: badgeInk,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transform: `scale(${Math.max(0, badgeScale)}) rotate(${(1 - ease.outCubic(pb)) * -14}deg)`,
            opacity: Math.min(1, pb * 4),
          }}
        >
          <span style={{ ...fontCss(f.headline, Math.round(L.badge * 0.58)), lineHeight: 1 }}>{i + 1}</span>
        </div>
        <div
          style={{
            position: 'absolute',
            left: textLeft,
            top: rowTop + (rowH - textH) / 2,
            width: L.col,
            color: theme.foreground,
            opacity: ease.outCubic(Math.min(1, pt * 1.8)),
            transform: `translateX(${(1 - ease.outQuart(pt)) * (rtl ? 36 : -36)}px)`,
          }}
        >
          {it.lines.map((line, li) => (
            <div key={li} style={{ ...fontCss(f.display, it.size), lineHeight: `${it.size * ITEM_LINE}px` }}>
              {line.join(' ')}
            </div>
          ))}
        </div>
      </React.Fragment>
    );
  });

  return (
    <Plate clock={clock} theme={theme} height={area.height}>
      {titleEl}
      {rows}
    </Plate>
  );
};
