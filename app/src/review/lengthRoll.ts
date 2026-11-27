/**
 * The final length rolls to its new value like an odometer: each digit is a column of 0 to 9
 * that slides to its digit; separators stay still. Columns are keyed by their place from the
 * right, so "9:59" to "10:00" keeps the three columns it had and adds one on the left. Pure,
 * unit-tested; `RollingNumber.tsx` draws it.
 */
export type RollSlot = { key: string; kind: 'digit'; digit: number } | { key: string; kind: 'char'; char: string };

export function rollSlots(text: string): RollSlot[] {
  const chars = [...text];
  return chars.map((ch, i) => {
    const key = `p${chars.length - 1 - i}`;
    const d = ch.charCodeAt(0) - 48;
    return d >= 0 && d <= 9 ? { key, kind: 'digit', digit: d } : { key, kind: 'char', char: ch };
  });
}

/** How far a digit column moves, in line heights: up for a larger digit. */
export function rollOffset(digit: number, lineHeight: number): number {
  return -digit * lineHeight;
}
