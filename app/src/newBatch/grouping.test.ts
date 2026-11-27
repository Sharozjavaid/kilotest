import { CreateBatchRequest, DEFAULT_SETTINGS, MODE_PRESETS, type CreateBatchResponse } from '@kilo/edl';
import {
  addBroll,
  countClips,
  effectiveVideoSettings,
  groupPicked,
  ownSettings,
  setVideoSettings,
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

describe('settings for one video', () => {
  const batch = { ...MODE_PRESETS.general.settings, hookVariations: 3 };
  let n = 0;
  const key = () => `k${++n}`;

  it('follow the batch until changed, and send only what differs', () => {
    let videos = groupPicked([file('a.mp4'), file('b.mp4'), file('c.mp4')], [], key);
    expect(effectiveVideoSettings(batch, videos[0]!)).toEqual({ mode: 'general', hooks: 3, own: false });
    videos = setVideoSettings(videos, videos[1]!.key, batch, { mode: 'tiktok_shop' });
    videos = setVideoSettings(videos, videos[1]!.key, batch, { hooks: 2 });
    videos = setVideoSettings(videos, videos[2]!.key, batch, { hooks: 1 });
    expect(effectiveVideoSettings(batch, videos[1]!)).toEqual({ mode: 'tiktok_shop', hooks: 2, own: true });
    const req = toCreateBatchRequest(batch, videos);
    expect(req.settings).toEqual(batch);
    expect(req.videos.map((v) => v.settings)).toEqual([undefined, { mode: 'tiktok_shop', pacing: 'tight', hookVariations: 2 }, { hookVariations: 1 }]);
    expect('settings' in req.videos[0]!).toBe(false);
  });

  it('a value equal to the batch is "follow the batch"; reset clears both', () => {
    let videos = groupPicked([file('a.mp4')], [], key);
    videos = setVideoSettings(videos, videos[0]!.key, batch, { mode: 'ugc_ad', hooks: 3 });
    expect(videos[0]).toMatchObject({ mode: 'ugc_ad' });
    expect(videos[0]!.hooks).toBeUndefined();
    // The batch moves to the video's mode: nothing of its own is left to send.
    const ugcBatch = { ...MODE_PRESETS.ugc_ad.settings };
    expect(ownSettings(ugcBatch, videos[0]!)).toBeUndefined();
    expect(ownSettings(batch, videos[0]!)).toEqual({ mode: 'ugc_ad', pacing: 'tight' });
    videos = setVideoSettings(videos, videos[0]!.key, batch, null);
    expect(videos[0]!.mode).toBeUndefined();
    expect(ownSettings(batch, videos[0]!)).toBeUndefined();
  });

  it('a merged video keeps the first video settings', () => {
    let videos = groupPicked([file('a.mp4'), file('b.mp4')], [], key);
    videos = setVideoSettings(videos, videos[0]!.key, batch, { mode: 'ugc_ad' });
    const merged = mergeVideos(videos, videos.map((v) => v.key));
    expect(merged).toHaveLength(1);
    expect(merged[0]!.mode).toBe('ugc_ad');
  });
});
