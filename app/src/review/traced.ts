/**
 * A rounded rectangle traced clockwise from the middle of its top edge. Returns the path and
 * its length, for a dash that grows with progress. Pure.
 */
export function tracedBorder(w: number, h: number, r: number, inset: number): { d: string; length: number } {
  const x0 = inset;
  const y0 = inset;
  const x1 = w - inset;
  const y1 = h - inset;
  const rr = Math.max(0, Math.min(r - inset, (x1 - x0) / 2, (y1 - y0) / 2));
  const mid = (x0 + x1) / 2;
  const d = [
    `M ${mid} ${y0}`,
    `H ${x1 - rr}`,
    `A ${rr} ${rr} 0 0 1 ${x1} ${y0 + rr}`,
    `V ${y1 - rr}`,
    `A ${rr} ${rr} 0 0 1 ${x1 - rr} ${y1}`,
    `H ${x0 + rr}`,
    `A ${rr} ${rr} 0 0 1 ${x0} ${y1 - rr}`,
    `V ${y0 + rr}`,
    `A ${rr} ${rr} 0 0 1 ${x0 + rr} ${y0}`,
    `H ${mid}`,
  ].join(' ');
  const length = 2 * (x1 - x0 - 2 * rr) + 2 * (y1 - y0 - 2 * rr) + 2 * Math.PI * rr;
  return { d, length };
}
