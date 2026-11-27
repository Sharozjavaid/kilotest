import type { VideoUploadProgress } from '@/uploads/queue';
import { batchRowState, firstReadyNow } from './batchRow';

const video = (status: string, extra: Record<string, unknown> = {}) =>
  ({ id: 'v1', status, progress: null, keptSec: 14, totalSec: 23, variantCount: 1, cutCount: 3, notice: null, ...extra }) as never;
const upload = (o: Partial<VideoUploadProgress> = {}): VideoUploadProgress => ({ videoId: 'v1', fraction: 0.4, files: 2, filesDone: 1, failed: 0, failedIds: [], complete: false, ...o });

describe('batchRowState', () => {
  it('shows a ring with the upload fraction while this phone sends the files', () => {
    const s = batchRowState(video('uploading'), upload(), 'uploading');
    expect(s).toMatchObject({ trailing: 'ring', ring: 0.4, veil: true, cut: false, href: null });
    expect(s.line).toBe('Uploading 40% · 1 of 2 files in');
  });
  it('turns the ring indeterminate while the video waits its turn', () => {
    expect(batchRowState(video('uploading'), upload(), 'waiting_turn').ring).toBeNull();
  });
  it('goes cut when an upload stopped or the phone is offline', () => {
    expect(batchRowState(video('uploading'), upload({ failed: 1 }), 'failed').cut).toBe(true);
    expect(batchRowState(video('uploading'), upload(), 'offline').cut).toBe(true);
  });
  it('shows editing progress with the percentage in the line', () => {
    const s = batchRowState(video('analyzing', { progress: 0.64 }), undefined, null);
    expect(s).toMatchObject({ trailing: 'ring', ring: 0.64, line: 'Editing: finding the best takes · 64%' });
  });
  it('offers Review once ready, and opens the edit', () => {
    expect(batchRowState(video('ready_for_review'), undefined, null)).toMatchObject({ trailing: 'review', href: '/review/v1', veil: false });
    expect(batchRowState(video('done'), undefined, null)).toMatchObject({ trailing: 'posted', href: '/export/v1' });
  });
  it('marks a failed video', () => {
    expect(batchRowState(video('failed'), undefined, null)).toMatchObject({ trailing: 'failed', cut: true, line: "Couldn't edit this video" });
  });
});

describe('firstReadyNow', () => {
  it('is true only on the change from none ready to some', () => {
    expect(firstReadyNow(null, 2)).toBe(false);
    expect(firstReadyNow(0, 1)).toBe(true);
    expect(firstReadyNow(1, 2)).toBe(false);
    expect(firstReadyNow(0, 0)).toBe(false);
  });
});
