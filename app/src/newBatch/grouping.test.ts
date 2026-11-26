import { CreateBatchRequest, DEFAULT_SETTINGS, type CreateBatchResponse } from '@kilo/edl';
import {
  addBroll,
  countClips,
  groupPicked,
  mergeVideos,
  moveClip,
  removeClip,
  renameVideo,
  splitClip,
  titleFromFilename,
  toCreateBatchRequest,
  uploadJobsFor,
  type PickedFile,
} from './grouping';

const file = (name: string, kind: 'video' | 'image' = 'video'): PickedFile => ({
  id: name,
  uri: `file:///${name}`,
  filename: name,
  contentType: kind === 'video' ? 'video/quicktime' : 'image/jpeg',
  sizeBytes: 100,
  kind,
});

let n = 0;
const key = () => `k${++n}`;

describe('grouping picked files into videos', () => {
  beforeEach(() => (n = 0));

  it('makes one video per picked file by default, titled from the file name', () => {
    const v = groupPicked([file('IMG_0001.MOV'), file('morning-routine.mp4')], [], key);
    expect(v.map((x) => x.title)).toEqual(['IMG 0001', 'morning routine']);
    expect(v.every((x) => x.clips.length === 1)).toBe(true);
    expect(titleFromFilename('.mov', 3)).toBe('Video 3');
  });

  it('appends later picks and ignores files already picked', () => {
    const first = groupPicked([file('a.mov')], [], key);
    const both = groupPicked([file('a.mov'), file('b.mov')], first, key);
    expect(both.map((x) => x.clips[0]!.id)).toEqual(['a.mov', 'b.mov']);
  });

  it('merges selected videos into the first, in list order, and reorders clips', () => {
    const v = groupPicked([file('a.mov'), file('b.mov'), file('c.mov')], [], key);
    const merged = mergeVideos(v, [v[2]!.key, v[0]!.key]);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.clips.map((c) => c.id)).toEqual(['a.mov', 'c.mov']);
    expect(merged[0]!.title).toBe('a');
    const moved = moveClip(merged, merged[0]!.key, 1, 0);
    expect(moved[0]!.clips.map((c) => c.id)).toEqual(['c.mov', 'a.mov']);
    expect(moveClip(merged, merged[0]!.key, 0, 5)).toEqual(merged);
    expect(countClips(moved)).toBe(3);
  });

  it('splits a clip back out, removes clips and drops empty videos', () => {
    const v = mergeVideos(groupPicked([file('a.mov'), file('b.mov')], [], key), ['k1', 'k2']);
    const split = splitClip(v, 'k1', 1, key);
    expect(split.map((x) => x.clips.map((c) => c.id))).toEqual([['a.mov'], ['b.mov']]);
    expect(removeClip(split, split[1]!.key, 0)).toHaveLength(1);
  });

  it('renames and attaches B-roll to one video', () => {
    let v = groupPicked([file('a.mov'), file('b.mov')], [], key);
    v = renameVideo(v, 'k2', 'Unboxing');
    v = addBroll(v, 'k2', [file('p.jpg', 'image'), file('p.jpg', 'image')]);
    expect(v[1]).toMatchObject({ title: 'Unboxing' });
    expect(v[1]!.broll).toHaveLength(1);
    expect(v[0]!.broll).toHaveLength(0);
  });

  it('builds a valid CreateBatchRequest and pairs upload targets with files', () => {
    let v = groupPicked([file('a.mov'), file('b.mov'), file('c.mov')], [], key);
    v = mergeVideos(v, ['k1', 'k2']);
    v = addBroll(v, 'k3', [file('p.jpg', 'image')]);
    v = renameVideo(v, 'k1', '   ');
    const req = toCreateBatchRequest(DEFAULT_SETTINGS, v);
    const parsed = CreateBatchRequest.parse(req);
    expect(parsed.videos[0]!.title).toBe('Video 1');
    expect(parsed.videos[0]!.clips.map((c) => c.filename)).toEqual(['a.mov', 'b.mov']);
    expect(parsed.videos[1]!.broll[0]!.kind).toBe('image');

    const t = (k: string) => ({ kind: 'put' as const, url: `https://u/${k}`, headers: {}, objectKey: k, bucket: 'kilo' });
    const res: CreateBatchResponse = {
      batch: { id: 'b1', createdAt: '2026-01-01T00:00:00Z', settings: DEFAULT_SETTINGS, total: 2, counts: { uploading: 2 } },
      videos: [
        { videoId: 'v1', clips: [{ clipId: 'c1', upload: t('c1') }, { clipId: 'c2', upload: t('c2') }], broll: [] },
        { videoId: 'v2', clips: [{ clipId: 'c3', upload: t('c3') }], broll: [{ assetId: 'a1', upload: t('a1') }] },
      ],
    };
    const jobs = uploadJobsFor(res, v);
    expect(jobs.map((j) => [j.id, j.videoId, j.kind, j.filename])).toEqual([
      ['c1', 'v1', 'clip', 'a.mov'],
      ['c2', 'v1', 'clip', 'b.mov'],
      ['c3', 'v2', 'clip', 'c.mov'],
      ['a1', 'v2', 'broll', 'p.jpg'],
    ]);
    expect(() => uploadJobsFor({ ...res, videos: res.videos.slice(1) }, v)).toThrow();
  });
});
