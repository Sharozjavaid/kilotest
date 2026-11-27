import { afterEach, describe, expect, it, vi } from 'vitest';
import { getGraphicTheme, GRAPHIC_THEMES } from '@kilo/edl';
import { frameSignatures } from '../src/holds.js';
import { normalizeRequest } from '../src/request.js';

/**
 * "`NaN` is an invalid value for the `top` css style property" came from the hold planner,
 * which draws every template in Node with a stub canvas: the stub had no ink metrics, so a
 * title's line pitch, and its `top`, were NaN. These are the props the fixtures' edits use
 * (the bold title of az_landscape's hook B was the first to warn), plus one of each template.
 */
const CASES: Array<{ template: string; props: Record<string, unknown>; durationSec: number }> = [
  { template: 'bold-title', props: { text: 'It charges in about forty minutes and lasts all week' }, durationSec: 1.6 },
  { template: 'bold-title', props: { text: 'This one is twelve dollars today' }, durationSec: 1.6 },
  { template: 'numbered-list', props: { title: 'Three mistakes everyone makes', items: ['You use too little', 'You forget your ears', 'You never reapply'] }, durationSec: 6 },
  { template: 'stat-callout', props: { value: '10%', label: 'Use code GLOW' }, durationSec: 1.2 },
  { template: 'keyword-pop', props: { words: ['Finally', 'fixed'] }, durationSec: 1.4 },
  { template: 'price-tag', props: { price: '$29', compareAt: '$50' }, durationSec: 2.2 },
];

afterEach(() => vi.restoreAllMocks());

describe('layout values are never NaN', () => {
  it('the hold planner draws every fixture graphic without a React style warning', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args.map(String).join(' ')));
    for (const theme of GRAPHIC_THEMES) {
      for (const c of CASES) {
        const n = normalizeRequest({ ...c, theme: getGraphicTheme(theme.id), fps: 30, width: 540, height: 960, outPath: '/dev/null' } as never);
        const sigs = await frameSignatures(n);
        expect(sigs, `${c.template} ${theme.id}`).not.toBeNull();
      }
    }
    expect(errors.filter((e) => /NaN|invalid value/i.test(e))).toEqual([]);
  });
});
