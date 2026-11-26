import type { BatchDetail, HomeResponse, VideoSummary } from '@kilo/edl';
import { batchNeedsPolling, homeNeedsPolling } from './queries';
import { compactNotice, reviewSubtitle } from '@/lib/format';
import { brollPoll, BROLL_POLL_LIMIT_MS } from '@/broll/polling';
import { onBeforeSignOut, runBeforeSignOut } from '@/auth/signOutHooks';
import type { UploadJob } from '@/uploads/queue';

const video = (id: string, status: VideoSummary['status'], extra: Partial<VideoSummary> = {}): VideoSummary => ({
  id, batchId: 'b1', title: id, status, createdAt: '2026-11-26T00:00:00Z', updatedAt: '2026-11-26T00:00:00Z', clipCount: 1,
  progress: null, thumbnailUrl: null, keptSec: 10, totalSec: 20, cutCount: 2, variantCount: 0, postedAt: null, error: null, notice: null, ...extra,
});
const goal = { videosPerWeek: 0, postedThisWeek: 0, streakWeeks: 0, weekStart: '2026-11-23', reminder: { enabled: false, hour: 9, timeZone: 'UTC' } };
const none = { canProgress: () => false, canProgressBatch: () => false };
const all = { canProgress: () => true, canProgressBatch: () => true };

describe('polling stops when nothing can move (finding 3)', () => {
  it('home polls a batch only while the server works on it or this phone still has its files to send', () => {
    const home = (counts: Record<string, number>): HomeResponse => ({
      goal, activeBatches: [{ id: 'b1', createdAt: '', settings: {} as never, total: 2, counts }], readyToReview: [], recent: [],
    });
    expect(homeNeedsPolling(home({ uploading: 2 }), all)).toBe(true);
    expect(homeNeedsPolling(home({ uploading: 2 }), none)).toBe(false);
    expect(homeNeedsPolling(home({ uploading: 1, analyzing: 1 }), none)).toBe(true);
    expect(homeNeedsPolling(home({ ready_for_review: 2 }), none)).toBe(false);
  });

  it('a batch polls a video stuck uploading only while its upload can still progress', () => {
    const batch = (videos: VideoSummary[]): BatchDetail => ({ id: 'b1', createdAt: '', settings: {} as never, total: videos.length, counts: {}, videos });
    expect(batchNeedsPolling(batch([video('v1', 'uploading')]), none)).toBe(false);
    expect(batchNeedsPolling(batch([video('v1', 'uploading')]), all)).toBe(true);
    expect(batchNeedsPolling(batch([video('v1', 'uploading'), video('v2', 'analyzing')]), none)).toBe(true);
    expect(batchNeedsPolling(batch([video('v1', 'ready_for_review'), video('v2', 'failed')]), all)).toBe(false);
  });

  it('the B-roll screen stops polling an asset whose upload stopped, and after the time limit', () => {
    const asset = (id: string, status: 'uploading' | 'processing' | 'ready') => ({
      id, kind: 'image' as const, durationSec: null, width: null, height: null, description: '', filename: `${id}.jpg`, source: 'user' as const, status, url: null, thumbnailUrl: null,
    });
    const job = (id: string, status: UploadJob['status']) => ({ id, kind: 'broll', status } as UploadJob);
    const t0 = 1_000_000;
    expect(brollPoll([asset('a1', 'uploading')], [job('a1', 'uploading')], t0, t0 + 1000)).toEqual({ poll: true, stuck: [] });
    expect(brollPoll([asset('a1', 'uploading')], [job('a1', 'failed')], t0, t0 + 1000)).toEqual({ poll: false, stuck: [{ id: 'a1', canRetry: true }] });
    expect(brollPoll([asset('a1', 'uploading')], [], t0, t0 + 1000)).toEqual({ poll: false, stuck: [{ id: 'a1', canRetry: false }] });
    expect(brollPoll([asset('a1', 'processing')], [], t0, t0 + 1000).poll).toBe(true);
    const late = t0 + BROLL_POLL_LIMIT_MS + 1;
    expect(brollPoll([asset('a1', 'uploading')], [job('a1', 'uploading')], t0, late)).toEqual({ poll: false, stuck: [{ id: 'a1', canRetry: true }] });
    expect(brollPoll([asset('a1', 'ready')], [], t0, late)).toEqual({ poll: false, stuck: [] });
  });
});

describe('no-speech notice on rows (finding 12)', () => {
  it('is shown in a compact form', () => {
    const notice = "We couldn't hear any speech in this video, so nothing was cut";
    expect(compactNotice(notice)).toBe('No speech heard');
    expect(reviewSubtitle(video('v1', 'ready_for_review', { notice }))).toBe('0:10 kept of 0:20 · 2 cuts · No speech heard');
    expect(reviewSubtitle(video('v1', 'ready_for_review'))).toBe('0:10 kept of 0:20 · 2 cuts');
    expect(compactNotice('Something long the creator should know about this video. More.')).toBe('Something long the creator should know…');
    expect(compactNotice(null)).toBeNull();
  });
});

describe('sign-out hooks (finding 10)', () => {
  it('run before the session is cleared, and a hung or failing hook never blocks sign-out', async () => {
    const ran: string[] = [];
    const off = [
      onBeforeSignOut(async () => void ran.push('unregister')),
      onBeforeSignOut(() => new Promise(() => {})),
      onBeforeSignOut(async () => {
        throw new Error('offline');
      }),
    ];
    const t0 = Date.now();
    await runBeforeSignOut(50);
    expect(ran).toEqual(['unregister']);
    expect(Date.now() - t0).toBeLessThan(1000);
    off.forEach((f) => f());
  });
});
