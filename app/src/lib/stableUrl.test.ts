import { forgetStableUrls, remember, stableStateFor } from './stableUrl';

describe('stableStateFor', () => {
  beforeEach(() => forgetStableUrls());

  it('keeps the state while the key stays the same', () => {
    const s = stableStateFor(null, 'v1', 'a?sig=1');
    expect(s).toEqual({ key: 'v1', url: 'a?sig=1' });
    expect(stableStateFor(s, 'v1', 'a?sig=2')).toBe(s);
  });

  it('starts over for a recycled cell handed another item', () => {
    const first = stableStateFor(null, 'v1', 'one.jpg');
    const second = stableStateFor(first, 'v2', 'two.jpg');
    expect(second).toEqual({ key: 'v2', url: 'two.jpg' });
  });

  it("uses the new item's remembered link, not the newest signature", () => {
    remember('v1', 'one.jpg?sig=old');
    const s = stableStateFor({ key: 'v2', url: 'two.jpg' }, 'v1', 'one.jpg?sig=new');
    expect(s.url).toBe('one.jpg?sig=old');
  });

  it('without a key follows the latest link on first use', () => {
    expect(stableStateFor(null, undefined, 'x')).toEqual({ key: undefined, url: 'x' });
  });
});
