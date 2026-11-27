import { nextVideoHref } from './revision';

describe("Export's Next video", () => {
  const v = (status: string) => ({ id: 'v2', batchId: 'b1', status });
  it('opens the next video where it is', () => {
    expect(nextVideoHref(v('ready_for_review'))).toBe('/review/v2');
    expect(nextVideoHref(v('rendering'))).toBe('/review/v2');
    expect(nextVideoHref(v('done'))).toBe('/export/v2');
    expect(nextVideoHref(v('analyzing'))).toBe('/batch/b1');
    expect(nextVideoHref(v('failed'))).toBe('/batch/b1');
  });
});
