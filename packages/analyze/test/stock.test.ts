import { describe, expect, it } from 'vitest';
import { createAnalyze } from '../src/analyze.js';
import { pexelsProvider, stockQuery } from '../src/stock.js';
import type { FetchLike } from '../src/transcribe.js';
import { ASSETS, decideInput, richClips } from './helpers.js';

/** Shapes of the Pexels video and photo search responses. */
const VIDEOS = {
  page: 1, per_page: 5, total_results: 1, url: 'https://www.pexels.com/videos/',
  videos: [
    {
      id: 857195, width: 1080, height: 1920, duration: 12, url: 'https://www.pexels.com/video/857195/',
      image: 'https://images.pexels.com/videos/857195/pictures/preview-0.jpg',
      user: { id: 1, name: 'Ana Lee', url: 'https://www.pexels.com/@ana' },
      video_files: [
        { id: 1, quality: 'hd', file_type: 'video/mp4', width: 1920, height: 1080, fps: 25, link: 'https://player.vimeo.com/external/landscape.hd.mp4' },
        { id: 2, quality: 'hd', file_type: 'video/mp4', width: 1080, height: 1920, fps: 25, link: 'https://player.vimeo.com/external/portrait.hd.mp4' },
        { id: 3, quality: 'uhd', file_type: 'video/mp4', width: 2160, height: 3840, fps: 25, link: 'https://player.vimeo.com/external/portrait.uhd.mp4' },
      ],
    },
  ],
};
const NO_VIDEOS = { page: 1, per_page: 5, total_results: 0, videos: [] };
const PHOTOS = {
  page: 1, per_page: 5, total_results: 1,
  photos: [{ id: 2014422, width: 3024, height: 4032, url: 'https://www.pexels.com/photo/2014422/', photographer: 'Joey Ng', photographer_url: 'https://www.pexels.com/@joey',
    src: { original: 'https://images.pexels.com/photos/2014422/o.jpeg', large2x: 'https://images.pexels.com/photos/2014422/l2.jpeg', portrait: 'https://images.pexels.com/photos/2014422/p.jpeg' } }],
};

function mock(route: (url: string) => unknown): { fetch: FetchLike; urls: string[]; auth: string[] } {
  const urls: string[] = [];
  const auth: string[] = [];
  return {
    urls, auth,
    fetch: async (url, init) => {
      urls.push(url);
      auth.push(init.headers.Authorization ?? '');
      const body = route(url);
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    },
  };
}

describe('pexels stock provider', () => {
  it('prefers a portrait mp4 near 1080 wide and credits the author', async () => {
    const m = mock(() => VIDEOS);
    const hit = await pexelsProvider({ apiKey: 'px-key', fetch: m.fetch }).search('morning routine');
    expect(hit).toEqual({ downloadUrl: 'https://player.vimeo.com/external/portrait.hd.mp4', kind: 'video', attribution: 'Video by Ana Lee on Pexels', query: 'morning routine' });
    expect(m.urls[0]).toBe('https://api.pexels.com/videos/search?query=morning%20routine&orientation=portrait&per_page=5');
    expect(m.auth[0]).toBe('px-key');
  });

  it('falls back to photos when no video matches', async () => {
    const m = mock((u) => (u.includes('/videos/') ? NO_VIDEOS : PHOTOS));
    const hit = await pexelsProvider({ apiKey: 'k', fetch: m.fetch }).search('stopwatch');
    expect(hit).toMatchObject({ kind: 'image', downloadUrl: 'https://images.pexels.com/photos/2014422/p.jpeg', attribution: 'Photo by Joey Ng on Pexels' });
    expect(m.urls[1]).toContain('https://api.pexels.com/v1/search?query=stopwatch');
  });

  it('suggestStockBroll searches lines without creator B-roll, up to max, only when configured', async () => {
    const input = decideInput(richClips(), { stockBroll: true });
    const m = mock(() => VIDEOS);
    const withKey = createAnalyze({ env: { PEXELS_API_KEY: 'px' }, fetch: m.fetch, decider: 'heuristic', log: () => {} });
    const out = await withKey.suggestStockBroll({ ...input, max: 2 });
    expect(out).toHaveLength(2);
    expect(new Set(out.map((c) => c.query)).size).toBe(2);
    expect(out.every((c) => c.query.length > 0 && c.attribution.includes('Pexels'))).toBe(true);
    // Lines the creator's own B-roll already covers are not searched.
    const covered = await withKey.suggestStockBroll({ ...input, broll: ASSETS, max: 10 });
    expect(covered.length).toBeLessThan((await withKey.suggestStockBroll({ ...input, max: 10 })).length);
    expect(await createAnalyze({ env: {}, log: () => {} }).suggestStockBroll({ ...input, max: 3 })).toEqual([]);
    expect(await withKey.suggestStockBroll({ ...input, settings: { ...input.settings, stockBroll: false }, max: 3 })).toEqual([]);
  });

  it('builds short concrete queries', () => {
    expect(stockQuery("Here's what nobody tells you about the serum.")).toBe('nobody tells serum');
  });
});
