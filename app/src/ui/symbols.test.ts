import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SF_SYMBOLS, sfSymbolFor, symbolWeightFor, tabSymbol } from './symbols';

// The symbols in SF Symbols 4.x or earlier, i.e. present on iOS 16.4 (the deployment target).
function symbolsUpTo4(): Set<string> {
  const dts = readFileSync(join(__dirname, '../../node_modules/sf-symbols-typescript/dist/index.d.ts'), 'utf8');
  const cut = dts.indexOf('export type SFSymbols5_0');
  expect(cut).toBeGreaterThan(0);
  return new Set([...dts.slice(0, cut).matchAll(/^\s*\| '([^']+)'$/gm)].map((m) => m[1]!));
}

describe('SF Symbols mapping', () => {
  const available = symbolsUpTo4();

  it('maps every icon to symbols that exist on iOS 16.4', () => {
    for (const [name, entry] of Object.entries(SF_SYMBOLS)) {
      expect({ name, sf: entry.sf, ok: available.has(entry.sf) }).toEqual({ name, sf: entry.sf, ok: true });
      if (entry.fill) expect({ name, fill: entry.fill, ok: available.has(entry.fill) }).toEqual({ name, fill: entry.fill, ok: true });
    }
  });

  it('uses the design brief tab symbols', () => {
    expect(tabSymbol('videos')).toEqual({ default: 'film.stack', selected: 'film.stack.fill' });
    expect(tabSymbol('styles')).toEqual({ default: 'slider.horizontal.3', selected: 'slider.horizontal.3' });
    expect(tabSymbol('user')).toEqual({ default: 'person.crop.circle', selected: 'person.crop.circle.fill' });
  });

  it('falls back to the outline symbol when there is no filled form', () => {
    expect(sfSymbolFor('check', true)).toBe('checkmark');
    expect(sfSymbolFor('trash', true)).toBe('trash.fill');
    expect(sfSymbolFor('trash')).toBe('trash');
  });

  it('matches stroke widths to symbol weights', () => {
    expect(symbolWeightFor(1.5)).toBe('regular');
    expect(symbolWeightFor(2)).toBe('medium');
    expect(symbolWeightFor(2.2)).toBe('semibold');
    expect(symbolWeightFor(3)).toBe('bold');
  });
});
