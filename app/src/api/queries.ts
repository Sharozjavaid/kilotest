import { QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BatchDetail, HomeResponse, RenderView, VideoDetail } from '@kilo/edl';
import { getApi } from './client';
import { isKiloApiError } from './errors';
import { isBusy } from './types';

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

export function homeNeedsPolling(home: HomeResponse | undefined): boolean {
  if (!home) return false;
  return home.activeBatches.length > 0 || [...home.readyToReview, ...home.recent].some((v) => isBusy(v.status));
}

export function batchNeedsPolling(batch: BatchDetail | undefined): boolean {
  return !!batch && batch.videos.some((v) => isBusy(v.status));
}

export function videoNeedsPolling(video: VideoDetail | undefined): boolean {
  if (!video) return false;
  return isBusy(video.status) || video.renders.some((r) => r.status === 'queued' || r.status === 'rendering');
}

export function useHome() {
  return useQuery({
    queryKey: keys.home,
    queryFn: () => getApi().home(),
    refetchInterval: (q) => (homeNeedsPolling(q.state.data) ? POLL_MS : false),
  });
}

export function useBatch(batchId: string | undefined) {
  return useQuery({
    queryKey: keys.batch(batchId ?? ''),
    queryFn: () => getApi().getBatch(batchId!),
    enabled: !!batchId,
    refetchInterval: (q) => (batchNeedsPolling(q.state.data) ? POLL_MS : false),
  });
}

export function useVideo(videoId: string | undefined) {
  return useQuery({
    queryKey: keys.video(videoId ?? ''),
    queryFn: () => getApi().getVideo(videoId!),
    enabled: !!videoId,
    refetchInterval: (q) => (videoNeedsPolling(q.state.data) ? POLL_MS : false),
  });
}

export function useRender(renderId: string | null | undefined) {
  return useQuery({
    queryKey: keys.render(renderId ?? ''),
    queryFn: () => getApi().getRender(renderId!),
    enabled: !!renderId,
    refetchInterval: (q) => {
      const r: RenderView | undefined = q.state.data;
      return !r || r.status === 'queued' || r.status === 'rendering' ? 1000 : false;
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
