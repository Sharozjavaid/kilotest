import type { VideoSummary } from '@kilo/edl';
import { finishedSubtitle } from './format';

const base: VideoSummary = {
  id: 'v', batchId: 'b', title: 'T', status: 'done', createdAt: '', updatedAt: '', clipCount: 1, progress: null, thumbnailUrl: null,
  keptSec: 75, totalSec: 90, cutCount: 3, variantCount: 1, postedAt: null, error: null, notice: null,
};

describe("Home's Finished rows", () => {
  it('says whether a video is still exporting, posted or ready to post', () => {
    expect(finishedSubtitle({ ...base, status: 'rendering' })).toBe('1:15 · Exporting');
    expect(finishedSubtitle(base)).toBe('1:15 · Ready to post');
    expect(finishedSubtitle({ ...base, postedAt: '2026-11-26T10:00:00Z' })).toBe('1:15 · Posted');
    expect(finishedSubtitle({ ...base, keptSec: null })).toBe('Ready to post');
  });
});
