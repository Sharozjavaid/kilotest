import { newlyReady, readyToastText } from './arrivals';

const v = (id: string, title = id) => ({ id, title });

describe('newlyReady', () => {
  it('says nothing on the first look', () => {
    expect(newlyReady(null, [v('a')])).toEqual([]);
  });
  it('names only the videos that were not there before', () => {
    expect(newlyReady(new Set(['a']), [v('a'), v('b'), v('c')]).map((x) => x.id)).toEqual(['b', 'c']);
  });
  it('ignores videos that left the list', () => {
    expect(newlyReady(new Set(['a', 'b']), [v('b')])).toEqual([]);
  });
});

describe('readyToastText', () => {
  it('names one video, counts several', () => {
    expect(readyToastText([])).toBeNull();
    expect(readyToastText([v('1', 'Morning routine')])).toBe('Morning routine is ready to review');
    expect(readyToastText([v('1'), v('2'), v('3')])).toBe('3 videos are ready to review');
  });
});
