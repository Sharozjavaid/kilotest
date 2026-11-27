import type { UploadJob } from '@/uploads/queue';
import { hasActiveUploads, uploadSummary, uploadSummaryLine } from './uploadSummary';

const job = (p: Partial<UploadJob> & Pick<UploadJob, 'id' | 'videoId' | 'status'>): UploadJob => ({
  kind: 'clip',
  batchId: 'b1',
  fileUri: 'file://x',
  filename: 'x.mov',
  contentType: 'video/quicktime',
  sizeBytes: 100,
  target: { method: 'PUT', url: 'https://x', headers: {} } as unknown as UploadJob['target'],
  bytesSent: 0,
  attempts: 0,
  nextAttemptAt: 0,
  ...p,
});

describe('uploads accessory', () => {
  it('shows nothing when nothing is on its way', () => {
    const jobs = [job({ id: 'a', videoId: 'v1', status: 'done' }), job({ id: 'b', videoId: 'v2', status: 'failed' })];
    expect(hasActiveUploads(jobs)).toBe(false);
    expect(uploadSummary(jobs)).toBeNull();
  });

  it('counts videos done of the batches still sending, and bytes', () => {
    const jobs = [
      job({ id: 'a', videoId: 'v1', status: 'done' }),
      job({ id: 'b', videoId: 'v2', status: 'uploading', bytesSent: 50 }),
      job({ id: 'c', videoId: 'v2', status: 'pending' }),
      job({ id: 'd', videoId: 'v9', status: 'done', batchId: 'old' }),
    ];
    const s = uploadSummary(jobs)!;
    expect(s).toMatchObject({ batchId: 'b1', videosDone: 1, videos: 2, failed: 0 });
    expect(s.fraction).toBeCloseTo(150 / 300);
    expect(uploadSummaryLine(s, false)).toBe('Uploading 1 of 2');
    expect(uploadSummaryLine(s, true)).toBe('Paused offline, 1 of 2');
  });
});
