import { allRendered, exportHeadline, overallProgress, postedToast, saveLabel, savedToast, versionState, type Version } from './versions';

const v = (render: Partial<NonNullable<Version['render']>> | undefined): Version => ({
  variantId: null,
  overlays: null,
  label: 'Hook A',
  hookText: '',
  durationSec: 30,
  render: render ? ({ id: 'r', status: 'rendering', progress: 0, url: null, quality: 'final', variantId: null, createdAt: '', error: null, ...render } as never) : undefined,
});

describe('export versions', () => {
  it('reads Tap to play once rendered, Exporting with the percentage before', () => {
    expect(versionState(v({ status: 'done', url: 'u' } as never))).toBe('Tap to play');
    expect(versionState(v({ progress: 0.643 }))).toBe('Exporting 64%');
    expect(versionState(v(undefined))).toBe('Exporting 0%');
    expect(versionState(v({ status: 'failed' } as never))).toBe('Failed');
  });

  it('averages progress over the versions, a done one counting whole', () => {
    expect(overallProgress([v({ status: 'done', url: 'u' } as never), v({ progress: 0.5 })])).toBeCloseTo(0.75);
    expect(overallProgress([])).toBe(0);
    expect(allRendered([v({ status: 'done', url: 'u' } as never)])).toBe(true);
    expect(allRendered([v({ status: 'done', url: null } as never)])).toBe(false);
  });

  it('names the headline and the primary button by platform and state', () => {
    expect(exportHeadline(1, true)).toBe('Ready to post');
    expect(exportHeadline(3, true)).toBe('3 versions ready');
    expect(exportHeadline(3, false)).toBe('Exporting 3 versions');
    expect(saveLabel({ web: false, n: 3, allDone: false, progress: 0.64, saved: false })).toBe('Preparing… 64%');
    expect(saveLabel({ web: false, n: 3, allDone: true, progress: 1, saved: false })).toBe('Save to Photos');
    expect(saveLabel({ web: false, n: 3, allDone: true, progress: 1, saved: true })).toBe('Saved to Photos');
    // The browser suite presses these exact names.
    expect(saveLabel({ web: true, n: 3, allDone: true, progress: 1, saved: false })).toBe('Download all 3');
    expect(saveLabel({ web: true, n: 1, allDone: true, progress: 1, saved: false })).toBe('Download');
  });

  it('words the toasts', () => {
    expect(savedToast(3, false)).toBe('3 versions saved to Photos');
    expect(savedToast(1, false)).toBe('Saved to Photos');
    expect(savedToast(2, true)).toBe('2 versions downloaded');
    expect(postedToast({ postedThisWeek: 3, videosPerWeek: 5 })).toBe('3 of 5 this week');
    expect(postedToast({ postedThisWeek: 3, videosPerWeek: 0 })).toBe('Marked as posted');
    expect(postedToast(null)).toBe('Marked as posted');
  });
});
