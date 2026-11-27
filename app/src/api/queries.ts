import { QueryClient, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useIsFocused } from 'expo-router';
import type { BatchDetail, HomeResponse, RenderView, VideoDetail, VideoSummary } from '@kilo/edl';
import { getApi } from './client';
import { isKiloApiError } from './errors';
import { isBusy, type ListVideosQuery } from './types';
import { uploadActivity, type UploadActivity } from '@/uploads/activity';

/** Query keys, in one place so invalidation stays consistent. */
export const keys = {
  home: ['home'] as const,
  batch: (id: string) => ['batch', id] as const,
  video: (id: string) => ['video', id] as const,
  videos: (q?: object) => ['videos', q ?? {}] as const,
  render: (id: string) => ['render', id] as const,
  goal: ['goal'] as const,
  styles: ['styles'] as const,
};

/** How often to poll while something is still moving on the server. */
export const POLL_MS = 2500;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        retry: (count, error) => {
          if (isKiloApiError(error) && !error.isTransient) return false;
          return count < 3;
        },
      },
      mutations: { retry: false },
    },
  });
}

/**
 * Poll only while something can still move: the server is working (queued,
 * analysing, rendering), or a video is uploading and this phone still has its files
 * to send. A video whose uploads all failed (or that waits for files from another
 * device) stays `uploading` until someone acts, and polling it would never end.
 */
export function homeNeedsPolling(home: HomeResponse | undefined, uploads: UploadActivity = uploadActivity()): boolean {
  if (!home) return false;
  const batchMoving = home.activeBatches.some(
    (b) => (b.counts.queued ?? 0) > 0 || (b.counts.analyzing ?? 0) > 0 || ((b.counts.uploading ?? 0) > 0 && uploads.canProgressBatch(b.id)),
  );
  return batchMoving || [...home.readyToReview, ...home.recent].some((v) => isBusy(v.status));
}

export function batchNeedsPolling(batch: BatchDetail | undefined, uploads: UploadActivity = uploadActivity()): boolean {
  return !!batch && batch.videos.some((v) => isBusy(v.status) && (v.status !== 'uploading' || uploads.canProgress(v.id)));
}

export function videoNeedsPolling(video: VideoDetail | undefined): boolean {
  if (!video) return false;
  return isBusy(video.status) || video.renders.some((r) => r.status === 'queued' || r.status === 'rendering');
}

/**
 * How often a screen's query polls: only while the screen is the one in front (focused)
 * and something can still move. A screen left under another one in the stack (Home under
 * Batch, Batch under Review) stays mounted, on web and native, and must not keep fetching.
 */
export function pollInterval(focused: boolean, needed: boolean): number | false {
  return focused && needed ? POLL_MS : false;
}

/**
 * Whether the calling screen is in front. A screen under another one also stops
 * listening to the cache (`subscribed: false`), so invalidations made elsewhere (an upload
 * finishing) do not refetch it while hidden; it catches up when it comes back to the front.
 */
export function useScreenFocused(): boolean {
  return useIsFocused();
}

export function useHome() {
  const focused = useScreenFocused();
  return useQuery({
    queryKey: keys.home,
    queryFn: () => getApi().home(),
    subscribed: focused,
    refetchInterval: (q) => pollInterval(focused, homeNeedsPolling(q.state.data)),
  });
}

/** `poll: false` for a screen that only reads the batch (Review's "3 of 30"). */
export function useBatch(batchId: string | undefined, opts: { poll?: boolean } = {}) {
  const focused = useScreenFocused();
  const poll = opts.poll ?? true;
  return useQuery({
    queryKey: keys.batch(batchId ?? ''),
    queryFn: () => getApi().getBatch(batchId!),
    enabled: !!batchId,
    subscribed: focused,
    refetchInterval: (q) => pollInterval(focused && poll, batchNeedsPolling(q.state.data)),
  });
}

export function useVideo(videoId: string | undefined) {
  const focused = useScreenFocused();
  return useQuery({
    queryKey: keys.video(videoId ?? ''),
    queryFn: () => getApi().getVideo(videoId!),
    enabled: !!videoId,
    subscribed: focused,
    refetchInterval: (q) => pollInterval(focused, videoNeedsPolling(q.state.data)),
  });
}

/** A page of the library. */
export const LIBRARY_PAGE = 40;

/** Library filters: a status group and words in the title. */
export type LibraryFilter = 'all' | 'review' | 'progress' | 'finished' | 'failed';

export const LIBRARY_STATUSES: Record<LibraryFilter, ListVideosQuery['status']> = {
  all: undefined,
  review: ['ready_for_review'],
  progress: ['uploading', 'queued', 'analyzing'],
  finished: ['rendering', 'done'],
  failed: ['failed'],
};

/**
 * The library (All videos): pages of GET /videos in batch order, newest batch first. The
 * next page starts after the last video of the one before (ListVideosResponse has no
 * cursor; a short page is the last). Never polls: a list of hundreds refreshes when the
 * screen comes back to the front or is pulled.
 */
export function useLibrary(filter: LibraryFilter, q: string) {
  const focused = useScreenFocused();
  return useInfiniteQuery({
    queryKey: keys.videos({ library: true, filter, q }),
    queryFn: ({ pageParam }) =>
      getApi().listVideos({ status: LIBRARY_STATUSES[filter], q: q.trim() || undefined, order: 'batch', limit: LIBRARY_PAGE, after: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.videos.length < LIBRARY_PAGE ? undefined : last.videos[last.videos.length - 1]!.id),
    subscribed: focused,
    staleTime: 30_000,
  });
}

/** Pages joined, without repeats (a video that moved between pages while scrolling shows once). */
export function libraryRows(pages: readonly { videos: VideoSummary[] }[] | undefined): VideoSummary[] {
  const seen = new Set<string>();
  const out: VideoSummary[] = [];
  for (const p of pages ?? []) {
    for (const v of p.videos) {
      if (seen.has(v.id)) continue;
      seen.add(v.id);
      out.push(v);
    }
  }
  return out;
}

export function useRender(renderId: string | null | undefined) {
  const focused = useScreenFocused();
  return useQuery({
    queryKey: keys.render(renderId ?? ''),
    queryFn: () => getApi().getRender(renderId!),
    enabled: !!renderId,
    subscribed: focused,
    refetchInterval: (q) => {
      const r: RenderView | undefined = q.state.data;
      return focused && (!r || r.status === 'queued' || r.status === 'rendering') ? 1000 : false;
    },
  });
}

export function useGoal() {
  return useQuery({ queryKey: keys.goal, queryFn: () => getApi().getGoal() });
}

/** Invalidates everything that shows a video's status. */
export function useInvalidateVideo() {
  const qc = useQueryClient();
  return (videoId?: string, batchId?: string) => {
    void qc.invalidateQueries({ queryKey: keys.home });
    if (videoId) void qc.invalidateQueries({ queryKey: keys.video(videoId) });
    if (batchId) void qc.invalidateQueries({ queryKey: keys.batch(batchId) });
    void qc.invalidateQueries({ queryKey: ['videos'] });
  };
}

export function useRetryVideo() {
  const invalidate = useInvalidateVideo();
  return useMutation({
    mutationFn: (videoId: string) => getApi().retryVideo(videoId),
    onSuccess: (v) => invalidate(v.id, v.batchId),
  });
}

export function useMarkPosted() {
  const qc = useQueryClient();
  const invalidate = useInvalidateVideo();
  return useMutation({
    mutationFn: (args: { videoId: string; platform: 'tiktok' | 'instagram' | 'other' }) =>
      getApi().markPosted(args.videoId, { platform: args.platform }),
    onSuccess: (v) => {
      invalidate(v.id, v.batchId);
      void qc.invalidateQueries({ queryKey: keys.goal });
    },
  });
}
