import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BatchDetail,
  CreateRenderResponse,
  HomeResponse,
  ListVideosResponse,
  SaveEdlResponse,
  VideoDetail,
  VideoSummary,
  resolveTimeline,
  type Edl,
} from '@kilo/edl';
import { createEnv, newUser, settings, uploadFixtures, waitFor, waitForStatus, type Client, type TestEnv } from './helpers.js';

/**
 * Variants hiding base overlays (Variant.hiddenOverlayIds), settings per video
 * (NewVideo.settings), and the paged library behind GET /v1/videos with the Home order.
 */
describe('hidden overlays, per-video settings and the library', () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await createEnv();
  });
  afterAll(async () => {
    await env?.stop();
  });

  const save = (user: Client, id: string, edl: Edl) => user.ok(SaveEdlResponse, 'PUT', `/v1/videos/${id}/edl`, { edl, baseRevision: edl.revision });
  const hide = (edl: Edl, variantId: string, ids: string[]): Edl => ({
    ...edl,
    variants: edl.variants.map((v) => (v.id === variantId ? { ...v, hiddenOverlayIds: ids } : v)),
  });

  describe('Variant.hiddenOverlayIds', () => {
    let user: Client;
    let id: string;
    let edl: Edl;

    beforeAll(async () => {
      user = env.as(newUser());
      const created = await uploadFixtures(user, ['routine'], { broll: true, settings: settings({ hookVariations: 3 }) });
      id = created.videos[0]!.videoId;
      edl = (await waitForStatus(user, id, 'ready_for_review')).edl!;
      expect(edl.variants.length).toBeGreaterThanOrEqual(2);
      expect(edl.overlays.some((o) => o.type === 'broll')).toBe(true);
    });

    it('a save may hide a base overlay in one variant; only that variant leaves it out', async () => {
      const broll = edl.overlays.find((o) => o.type === 'broll')!;
      const [a, b] = edl.variants;
      const saved = (await save(user, id, hide(edl, b!.id, [broll.id]))).edl;
      expect(saved.variants.find((v) => v.id === b!.id)!.hiddenOverlayIds).toEqual([broll.id]);
      expect(saved.variants.find((v) => v.id === a!.id)!.hiddenOverlayIds).toEqual([]);
      expect(resolveTimeline(saved, b!.id).overlays.some((o) => o.overlay.id === broll.id)).toBe(false);
      expect(resolveTimeline(saved, a!.id).overlays.some((o) => o.overlay.id === broll.id)).toBe(true);
      // Showing it again is a save too.
      const shown = (await save(user, id, hide(saved, b!.id, []))).edl;
      expect(shown.variants.every((v) => v.hiddenOverlayIds.length === 0)).toBe(true);
      edl = shown;
    });

    it('ids that name no base overlay, repeats and too many are 400', async () => {
      const base = edl.overlays[0]!;
      const v = edl.variants[0]!.id;
      await user.err(400, 'invalid_request', 'PUT', `/v1/videos/${id}/edl`, { edl: hide(edl, v, ['no-such-overlay']), baseRevision: edl.revision });
      await user.err(400, 'invalid_request', 'PUT', `/v1/videos/${id}/edl`, { edl: hide(edl, v, [base.id, base.id]), baseRevision: edl.revision });
      await user.err(400, 'invalid_request', 'PUT', `/v1/videos/${id}/edl`, {
        edl: hide(edl, v, Array.from({ length: 41 }, (_, i) => `x${i}`)),
        baseRevision: edl.revision,
      });
      // A variant's own overlay is not a base overlay.
      const withOwn: Edl = {
        ...edl,
        variants: edl.variants.map((x, i) =>
          i === 0
            ? {
                ...x,
                overlays: [{ id: 'own-title', type: 'graphic', template: 'bold-title', props: { text: 'Hi' }, anchorSegmentId: x.segmentOrder[0]!, offsetSec: 0, durationSec: 1 }],
                hiddenOverlayIds: ['own-title'],
              }
            : x,
        ),
      };
      await user.err(400, 'invalid_request', 'PUT', `/v1/videos/${id}/edl`, { edl: withOwn, baseRevision: edl.revision });
    });

    it('an overlay deleted by a save, or with its B-roll, is dropped from every variant', async () => {
      const graphic = edl.overlays.find((o) => o.type === 'graphic');
      const broll = edl.overlays.find((o) => o.type === 'broll')!;
      const hidden = [broll.id, ...(graphic ? [graphic.id] : [])];
      let cur = (await save(user, id, { ...edl, variants: edl.variants.map((v) => ({ ...v, hiddenOverlayIds: hidden })) })).edl;
      expect(cur.variants.every((v) => v.hiddenOverlayIds.length === hidden.length)).toBe(true);
      if (graphic) {
        // The client removes the graphic but still lists it as hidden: the server drops the stale id.
        cur = (await save(user, id, { ...cur, overlays: cur.overlays.filter((o) => o.id !== graphic.id) })).edl;
        expect(cur.variants.every((v) => JSON.stringify(v.hiddenOverlayIds) === JSON.stringify([broll.id]))).toBe(true);
      }
      expect(broll.type).toBe('broll');
      const assetId = broll.type === 'broll' ? broll.assetId : '';
      expect((await user.req('DELETE', `/v1/videos/${id}/broll/${assetId}`)).status).toBe(204);
      const after = await user.ok(VideoDetail, 'GET', `/v1/videos/${id}`);
      expect(after.edl!.revision).toBe(cur.revision + 1);
      expect(after.edl!.overlays.some((o) => o.id === broll.id)).toBe(false);
      expect(after.edl!.variants.every((v) => v.hiddenOverlayIds.length === 0)).toBe(true);
    });

    it('a replan that takes overlays away drops their hidden ids instead of failing', async () => {
      const cur = (await user.ok(VideoDetail, 'GET', `/v1/videos/${id}`)).edl!;
      const graphic = cur.overlays.find((o) => o.type === 'graphic');
      if (!graphic) return;
      const saved = (await save(user, id, { ...cur, variants: cur.variants.map((v) => ({ ...v, hiddenOverlayIds: [graphic.id] })) })).edl;
      expect(saved.variants[0]!.hiddenOverlayIds).toEqual([graphic.id]);
      await user.ok(VideoSummary, 'POST', `/v1/videos/${id}/replan`, { passes: ['graphics'] });
      const replanned = await waitFor(async () => {
        const d = await user.ok(VideoDetail, 'GET', `/v1/videos/${id}`);
        return d.status === 'ready_for_review' && d.edl!.revision > saved.revision ? d : null;
      }, 'the replan');
      const base = new Set(replanned.edl!.overlays.map((o) => o.id));
      expect(replanned.edl!.variants.every((v) => v.hiddenOverlayIds.every((h) => base.has(h)))).toBe(true);
    });
  });

  describe('NewVideo.settings', () => {
    it('is laid over the batch settings, stored per video and used for analysis and replans; the batch keeps its defaults', async () => {
      const user = env.as(newUser());
      const batchSettings = settings({ mode: 'general', hookVariations: 3 });
      const created = await uploadFixtures(user, ['routine', 'routine', 'routine'], {
        settings: batchSettings,
        titles: ['Default', 'Shop two hooks', 'Single opening'],
        videoSettings: [undefined, { mode: 'tiktok_shop', hookVariations: 2, pacing: 'tight' }, { hookVariations: 1 }],
      });
      const [a, b, c] = created.videos.map((v) => v.videoId);
      const [va, vb, vc] = await Promise.all([a!, b!, c!].map((x) => waitForStatus(user, x, 'ready_for_review')));
      expect(va!.edl!.settings).toMatchObject({ mode: 'general', hookVariations: 3, pacing: 'natural' });
      expect(va!.edl!.variants).toHaveLength(3);
      expect(vb!.edl!.settings).toMatchObject({ mode: 'tiktok_shop', hookVariations: 2, pacing: 'tight', captions: batchSettings.captions });
      expect(vb!.edl!.variants).toHaveLength(2);
      expect(vc!.edl!.settings).toMatchObject({ mode: 'general', hookVariations: 1 });
      expect(vc!.edl!.variants).toHaveLength(0);
      const rows = await env.sql<{ id: string; settings: { mode: string; hookVariations: number } }[]>`select id, settings from videos where id in ${env.sql([a!, b!, c!])}`;
      expect(rows.find((r) => r.id === b)!.settings).toMatchObject({ mode: 'tiktok_shop', hookVariations: 2 });
      // The batch's settings are its defaults, unchanged by its videos' own.
      const batch = await user.ok(BatchDetail, 'GET', `/v1/batches/${created.batch.id}`);
      expect(batch.settings).toEqual(batchSettings);
      expect(created.batch.settings).toEqual(batchSettings);
      // A replan of the variants makes as many hooks as the video asked for, not the batch.
      await user.ok(VideoSummary, 'POST', `/v1/videos/${b}/replan`, { passes: ['variants'] });
      const replanned = await waitFor(async () => {
        const d = await user.ok(VideoDetail, 'GET', `/v1/videos/${b}`);
        return d.status === 'ready_for_review' && d.edl!.revision > vb!.edl!.revision ? d : null;
      }, 'the replan');
      expect(replanned.edl!.variants).toHaveLength(2);
      expect(replanned.edl!.settings.mode).toBe('tiktok_shop');
    });

    it('a per-video value outside the settings schema is 400', async () => {
      const user = env.as(newUser());
      const body = {
        settings: settings(),
        videos: [{ title: 'Bad', source: 'upload', clips: [{ filename: 'a.mp4', contentType: 'video/mp4', sizeBytes: 10 }], settings: { hookVariations: 9 } }],
      };
      await user.err(400, 'invalid_request', 'POST', '/v1/batches', body);
      await user.err(400, 'invalid_request', 'POST', '/v1/batches', { ...body, videos: [{ ...body.videos[0], settings: { mode: 'podcast' } }] });
    });
  });

  describe('the library and Home at scale', () => {
    let user: Client;
    let first: { batchId: string; ids: string[] };
    let second: { batchId: string; ids: string[] };

    beforeAll(async () => {
      user = env.as(newUser());
      const one = await uploadFixtures(user, ['routine', 'routine', 'routine'], { titles: ['Alpha one', 'Alpha two', 'Alpha three'] });
      await Promise.all(one.videos.map((v) => waitForStatus(user, v.videoId, 'ready_for_review')));
      const two = await uploadFixtures(user, ['routine', 'routine'], { titles: ['Beta one', 'Beta two'] });
      await Promise.all(two.videos.map((v) => waitForStatus(user, v.videoId, 'ready_for_review')));
      first = { batchId: one.batch.id, ids: one.videos.map((v) => v.videoId) };
      second = { batchId: two.batch.id, ids: two.videos.map((v) => v.videoId) };
    });

    it('Home lists ready videos newest batch first, each batch in its own order, and keeps the batch until all are done', async () => {
      const home = await user.ok(HomeResponse, 'GET', '/v1/home');
      expect(home.readyToReview.map((v) => v.id)).toEqual([...second.ids, ...first.ids]);
      // Every video ready, none done yet: both batches stay reachable.
      expect(home.activeBatches.map((b) => b.id)).toEqual([second.batchId, first.batchId]);
    });

    it('GET /videos pages in batch order with a cursor, filters by status and searches titles', async () => {
      const all = await user.ok(ListVideosResponse, 'GET', '/v1/videos?order=batch');
      expect(all.videos.map((v) => v.id)).toEqual([...second.ids, ...first.ids]);
      const seen: string[] = [];
      let after: string | undefined;
      for (let page = 0; page < 5; page++) {
        const res = await user.ok(ListVideosResponse, 'GET', `/v1/videos?order=batch&limit=2${after ? `&after=${after}` : ''}`);
        seen.push(...res.videos.map((v) => v.id));
        if (res.videos.length < 2) break;
        after = res.videos.at(-1)!.id;
      }
      expect(seen).toEqual([...second.ids, ...first.ids]);
      // Newest first (the default order), paged the same way.
      const created = await user.ok(ListVideosResponse, 'GET', '/v1/videos');
      const p1 = await user.ok(ListVideosResponse, 'GET', '/v1/videos?limit=3');
      const p2 = await user.ok(ListVideosResponse, 'GET', `/v1/videos?limit=3&after=${p1.videos.at(-1)!.id}`);
      expect([...p1.videos, ...p2.videos].map((v) => v.id)).toEqual(created.videos.map((v) => v.id));

      const search = await user.ok(ListVideosResponse, 'GET', `/v1/videos?order=batch&q=${encodeURIComponent('alpha T')}`);
      expect(search.videos.map((v) => v.title)).toEqual(['Alpha two', 'Alpha three']);
      expect((await user.ok(ListVideosResponse, 'GET', `/v1/videos?q=${encodeURIComponent('100%_')}`)).videos).toEqual([]);

      // A finished video, found with a list of statuses.
      const target = first.ids[1]!;
      const { renders } = await user.ok(CreateRenderResponse, 'POST', `/v1/videos/${target}/renders`, { quality: 'final' }, 201);
      expect(renders.length).toBeGreaterThan(0);
      await waitForStatus(user, target, 'done');
      const finished = await user.ok(ListVideosResponse, 'GET', '/v1/videos?status=rendering,done&order=batch');
      expect(finished.videos.map((v) => v.id)).toEqual([target]);
      const toReview = await user.ok(ListVideosResponse, 'GET', '/v1/videos?status=ready_for_review&order=batch&limit=10');
      expect(toReview.videos.map((v) => v.id)).toEqual([...second.ids, first.ids[0], first.ids[2]]);
    });

    it('refuses bad paging and filter parameters', async () => {
      await user.err(400, 'invalid_request', 'GET', '/v1/videos?limit=0');
      await user.err(400, 'invalid_request', 'GET', '/v1/videos?limit=201');
      await user.err(400, 'invalid_request', 'GET', '/v1/videos?limit=abc');
      await user.err(400, 'invalid_request', 'GET', '/v1/videos?order=title');
      await user.err(400, 'invalid_request', 'GET', '/v1/videos?status=done,nope');
      await user.err(400, 'invalid_request', 'GET', '/v1/videos?after=not-an-id');
      // Another account's video is no cursor.
      const other = env.as(newUser());
      await other.err(400, 'invalid_request', 'GET', `/v1/videos?after=${first.ids[0]}`);
    });
  });
});
