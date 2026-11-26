import type { DecideInput, StockCandidate } from '@kilo/edl';
import { buildChunks, prepareClipWords } from './chunks.js';
import { heuristicCuts } from './heuristic.js';
import { matchScore } from './overlays.js';
import { STOPWORDS, key, tokens } from './text.js';
import type { FetchLike } from './transcribe.js';

export interface StockProvider {
  readonly name: string;
  search(query: string): Promise<StockCandidate | null>;
}

interface PexelsVideo {
  id: number;
  url?: string;
  duration?: number;
  user?: { name?: string };
  video_files?: Array<{ quality?: string; file_type?: string; width?: number; height?: number; link: string }>;
}
interface PexelsPhoto {
  id: number;
  url?: string;
  photographer?: string;
  src?: { original?: string; large2x?: string; large?: string; portrait?: string };
}

export function pexelsProvider(opts: { apiKey: string; fetch?: FetchLike; baseUrl?: string }): StockProvider {
  const doFetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const base = (opts.baseUrl ?? 'https://api.pexels.com').replace(/\/+$/, '');
  const get = async (path: string): Promise<unknown> => {
    const res = await doFetch(`${base}${path}`, { method: 'GET', headers: { Authorization: opts.apiKey }, body: undefined });
    if (!res.ok) throw new Error(`Pexels returned ${res.status}`);
    return res.json();
  };
  return {
    name: 'pexels',
    async search(query) {
      const q = encodeURIComponent(query);
      const vids = ((await get(`/videos/search?query=${q}&orientation=portrait&per_page=5`)) as { videos?: PexelsVideo[] }).videos ?? [];
      for (const v of vids) {
        const files = (v.video_files ?? []).filter((f) => f.file_type === 'video/mp4' && f.link);
        // Prefer portrait files close to 1080 wide; never the huge originals.
        const best = files
          .map((f) => ({ f, score: Math.abs((f.width ?? 0) - 1080) + ((f.height ?? 0) < (f.width ?? 0) ? 2000 : 0) }))
          .sort((a, b) => a.score - b.score)[0]?.f;
        if (best) {
          return { downloadUrl: best.link, kind: 'video', attribution: `Video by ${v.user?.name ?? 'unknown'} on Pexels`, query };
        }
      }
      const photos = ((await get(`/v1/search?query=${q}&orientation=portrait&per_page=5`)) as { photos?: PexelsPhoto[] }).photos ?? [];
      const p = photos.find((x) => x.src?.portrait || x.src?.large2x || x.src?.large);
      if (p) {
        return {
          downloadUrl: (p.src!.portrait ?? p.src!.large2x ?? p.src!.large)!,
          kind: 'image',
          attribution: `Photo by ${p.photographer ?? 'unknown'} on Pexels`,
          query,
        };
      }
      return null;
    },
  };
}

/** Two or three concrete words from a line, for a stock search. */
export function stockQuery(text: string): string {
  const words = tokens(text).filter((t) => !STOPWORDS.has(key(t)) && !/\d/.test(t) && t.length > 2);
  return [...new Set(words)].slice(0, 3).join(' ');
}

/** Lines with no creator B-roll that fits get a stock search each, up to `max`. */
export async function suggestStock(input: DecideInput & { max: number }, provider: StockProvider | null): Promise<StockCandidate[]> {
  if (!provider || input.max <= 0 || !input.settings.stockBroll) return [];
  const clipWords = prepareClipWords(input.clips, input.transcripts);
  const chunks = buildChunks(clipWords);
  const decisions = heuristicCuts({ chunks, clipWords, settings: input.settings, script: input.script });
  // Skip the hook: stock never covers the opening.
  const kept = chunks.filter((c) => decisions.get(c.id)?.keep).slice(1);
  const out: StockCandidate[] = [];
  const seen = new Set<string>();
  for (const c of kept) {
    if (out.length >= input.max) break;
    if (input.broll.some((a) => matchScore(a.description, c.text) > 0)) continue;
    const q = stockQuery(c.text);
    if (!q || seen.has(q)) continue;
    seen.add(q);
    try {
      const hit = await provider.search(q);
      if (hit) out.push(hit);
    } catch {
      // A failing search only means fewer suggestions.
    }
  }
  return out;
}
