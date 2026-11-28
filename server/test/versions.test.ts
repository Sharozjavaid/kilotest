import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  CreateRenderResponse,
  DEFAULT_SETTINGS,
  EdlVersionResponse,
  ListEdlVersionsResponse,
  RenderView,
  SaveEdlResponse,
  VideoDetail,
  VideoSummary,
  diffEdl,
  resolveTimeline,
  summarizeChanges,
  toggleSegment,
  type Edl,
} from '@kilo/edl';
import { connect, type Sql } from '../src/db/index.js';
import { MIGRATIONS_DIR, migrate } from '../src/db/migrate.js';
import { SERVER_DIR, createEnv, newUser, settings, uploadFixtures, waitFor, waitForStatus, type Client, type TestEnv } from './helpers.js';

const brollIds = (edl: Edl) =>
  [...edl.overlays, ...edl.variants.flatMap((v) => v.overlays)].flatMap((o) => (o.type === 'broll' ? [o.assetId] : []));

/** A segment that is cut, after the first kept one: keeping it again moves no overlay into the hook. */
function cutSegmentAfterHook(edl: Edl): string {
  const first = edl.segments.findIndex((s) => s.keep);
  const seg = edl.segments.find((s, i) => i > first && !s.keep);
  if (!seg) throw new Error('fixture has no cut segment after the hook');
  return seg.id;
}

describe('edit versions: list, read and restore (CONTRACTS.md section 3, Versions)', () => {
  let env: TestEnv;
  let user: Client;
  let stranger: Client;
  let id: string;
  /** The EDL at each revision, as the API returned it when it was current. */
  const at: Edl[] = [];
  let assetGone: string;
  let assetKept: string;

  beforeAll(async () => {
    env = await createEnv();
    user = env.as(newUser());
    stranger = env.as(newUser());
    const created = await uploadFixtures(user, ['unboxing'], { broll: true, settings: settings({ hookVariations: 2 }) });
    id = created.videos[0]!.videoId;
    const ready = await waitForStatus(user, id, 'ready_for_review');
    at.push(ready.edl!);
    expect(ready.edl!.revision).toBe(0);
    expect(ready.edl!.variants.length).toBeGreaterThanOrEqual(1);
    expect(ready.broll.every((b) => b.status === 'ready')).toBe(true);
    [assetGone, assetKept] = ready.broll.map((b) => b.id) as [string, string];

    // Revision 1: the creator keeps a line again.
    const saved = await user.ok(SaveEdlResponse, 'PUT', `/v1/videos/${id}/edl`, { edl: toggleSegment(ready.edl!, cutSegmentAfterHook(ready.edl!)), baseRevision: 0 });
    at.push(saved.edl);

    // Revision 2: a replan places both B-roll files.
    await user.ok(VideoSummary, 'POST', `/v1/videos/${id}/replan`, { passes: ['broll'] });
    const placed = await waitFor(async () => {
      const v = await user.ok(VideoDetail, 'GET', `/v1/videos/${id}`);
      return v.status === 'ready_for_review' && v.edl!.revision === 2 ? v : null;
    }, 'the replan');
    expect(new Set(brollIds(placed.edl!))).toEqual(new Set([assetGone, assetKept]));
    at.push(placed.edl!);

    // Revision 3: the first variant hides the overlay of the B-roll about to be deleted.
    const goneOverlay = placed.edl!.overlays.find((o) => o.type === 'broll' && o.assetId === assetGone)!;
    const hiding: Edl = {
      ...placed.edl!,
      variants: placed.edl!.variants.map((v, i) => (i === 0 ? { ...v, hiddenOverlayIds: [goneOverlay.id] } : v)),
    };
    at.push((await user.ok(SaveEdlResponse, 'PUT', `/v1/videos/${id}/edl`, { edl: hiding, baseRevision: 2 })).edl);
    expect(at[3]!.variants[0]!.hiddenOverlayIds).toEqual([goneOverlay.id]);

    // Revision 4: deleting that B-roll file removes its overlays (author system).
    expect((await user.req('DELETE', `/v1/videos/${id}/broll/${assetGone}`)).status).toBe(204);
    at.push((await user.ok(VideoDetail, 'GET', `/v1/videos/${id}`)).edl!);
    expect(at[4]!.revision).toBe(4);
  });
  afterAll(async () => {
    await env?.stop();
  });

  it('lists every revision newest first, with its author, length and changes from the one before', async () => {
    const list = await user.ok(ListEdlVersionsResponse, 'GET', `/v1/videos/${id}/edl/versions`);
    expect(list.current).toBe(4);
    expect(list.versions.map((v) => v.revision)).toEqual([4, 3, 2, 1, 0]);
    expect(list.versions.map((v) => v.author)).toEqual(['system', 'user', 'replan', 'user', 'decider']);
    expect(list.versions.every((v) => v.restoredFrom === null)).toBe(true);
    for (const v of list.versions) {
      const edl = at[v.revision]!;
      expect(v.durationSec).toBeCloseTo(resolveTimeline(edl).durationSec, 9);
      expect(new Date(v.createdAt).toISOString()).toBe(v.createdAt);
      expect(v.summary).toBe(v.revision === 0 ? 'First edit' : summarizeChanges(diffEdl(at[v.revision - 1]!, edl)));
    }
    const byRev = new Map(list.versions.map((v) => [v.revision, v.summary]));
    expect(byRev.get(1)).toMatch(/line kept/);
    // The replan re-places the same B-roll files; whether that moves any of them depends on the fake placement.
    expect(byRev.get(2)).toEqual(expect.any(String));
    expect(byRev.get(4)).toMatch(/B-roll/);
  });

  it('reads one revision exactly as stored; 404 for one the video does not have, 400 for a malformed one', async () => {
    for (const rev of [0, 2, 4]) {
      const one = await user.ok(EdlVersionResponse, 'GET', `/v1/videos/${id}/edl/versions/${rev}`);
      expect(one.edl).toEqual(at[rev]);
      expect(one.version.revision).toBe(rev);
      expect(one.version.summary).toBe(rev === 0 ? 'First edit' : summarizeChanges(diffEdl(at[rev - 1]!, at[rev]!)));
    }
    const raw = await env.sql<{ edl: Edl }[]>`select edl from edls where video_id = ${id} and revision = 2`;
    expect((await user.ok(EdlVersionResponse, 'GET', `/v1/videos/${id}/edl/versions/2`)).edl).toEqual(raw[0]!.edl);
    await user.err(404, 'not_found', 'GET', `/v1/videos/${id}/edl/versions/5`);
    await user.err(404, 'not_found', 'GET', `/v1/videos/${id}/edl/versions/99999999999`);
    for (const bad of ['-1', '1.5', 'abc', '1e3', '%20']) await user.err(400, 'invalid_request', 'GET', `/v1/videos/${id}/edl/versions/${bad}`);
  });

  it("another user's video is a 404 on every version route", async () => {
    await stranger.err(404, 'not_found', 'GET', `/v1/videos/${id}/edl/versions`);
    await stranger.err(404, 'not_found', 'GET', `/v1/videos/${id}/edl/versions/0`);
    await stranger.err(404, 'not_found', 'POST', `/v1/videos/${id}/edl/restore`, { revision: 0, baseRevision: 4 });
    await user.err(404, 'not_found', 'GET', `/v1/videos/${randomUUID()}/edl/versions`);
    expect((await user.ok(VideoDetail, 'GET', `/v1/videos/${id}`)).edl!.revision).toBe(4);
  });

  it('refuses a stale base (409), the current revision (400), a missing one (404) and a bad body (400)', async () => {
    await user.err(409, 'revision_conflict', 'POST', `/v1/videos/${id}/edl/restore`, { revision: 1, baseRevision: 3 });
    await user.err(400, 'invalid_request', 'POST', `/v1/videos/${id}/edl/restore`, { revision: 4, baseRevision: 4 });
    await user.err(404, 'not_found', 'POST', `/v1/videos/${id}/edl/restore`, { revision: 7, baseRevision: 4 });
    await user.err(404, 'not_found', 'POST', `/v1/videos/${id}/edl/restore`, { revision: 2 ** 40, baseRevision: 4 });
    await user.err(400, 'invalid_request', 'POST', `/v1/videos/${id}/edl/restore`, { revision: -1, baseRevision: 4 });
    await user.err(400, 'invalid_request', 'POST', `/v1/videos/${id}/edl/restore`, { revision: 1 });
    // As the save: only while ready_for_review or done.
    await env.sql`update videos set status = 'analyzing' where id = ${id}`;
    await user.err(409, 'invalid_state', 'POST', `/v1/videos/${id}/edl/restore`, { revision: 1, baseRevision: 4 });
    await env.sql`update videos set status = 'ready_for_review' where id = ${id}`;
    expect((await user.ok(ListEdlVersionsResponse, 'GET', `/v1/videos/${id}/edl/versions`)).current).toBe(4);
  });

  it('restores an old revision as a new one, without the overlays of deleted B-roll or hidden ids left naming nothing', async () => {
    const res = await user.ok(SaveEdlResponse, 'POST', `/v1/videos/${id}/edl/restore`, { revision: 3, baseRevision: 4 });
    expect(res.edl.revision).toBe(5);
    expect(brollIds(res.edl)).not.toContain(assetGone);
    expect(brollIds(res.edl)).toContain(assetKept);
    expect(res.edl.variants.every((v) => v.hiddenOverlayIds.length === 0)).toBe(true);
    // Everything else is revision 3's edit: its cuts, captions and the overlays that still have their files.
    expect(res.edl.segments).toEqual(at[3]!.segments);
    expect(res.edl.overlays).toEqual(at[3]!.overlays.filter((o) => !(o.type === 'broll' && o.assetId === assetGone)));
    expect(res.edl.captions).toEqual(at[3]!.captions);

    const video = await user.ok(VideoDetail, 'GET', `/v1/videos/${id}`);
    expect(video.edl).toEqual(res.edl);
    expect(video.status).toBe('ready_for_review');
    const list = await user.ok(ListEdlVersionsResponse, 'GET', `/v1/videos/${id}/edl/versions`);
    expect(list.current).toBe(5);
    expect(list.versions[0]).toMatchObject({ revision: 5, author: 'user', restoredFrom: 3, summary: summarizeChanges(diffEdl(at[4]!, res.edl)) });
    // Nothing earlier changed: history only moves forward.
    for (const rev of [0, 1, 2, 3, 4]) expect((await user.ok(EdlVersionResponse, 'GET', `/v1/videos/${id}/edl/versions/${rev}`)).edl).toEqual(at[rev]);
    // The stored row carries restored_from; the client's next save builds on revision 5.
    const [row] = await env.sql<{ restored_from: number | null; author: string }[]>`select restored_from, author from edls where video_id = ${id} and revision = 5`;
    expect(row).toEqual({ restored_from: 3, author: 'user' });
    await user.err(409, 'revision_conflict', 'PUT', `/v1/videos/${id}/edl`, { edl: at[4], baseRevision: 4 });
    at.push(res.edl);
  });

  it('a restore that would not pass the save checks answers 400 and stores nothing', async () => {
    // Revision 1 as stored, tampered with to anchor an overlay to a segment the video does not have.
    const [old] = await env.sql<{ edl: Edl }[]>`select edl from edls where video_id = ${id} and revision = 1`;
    const broken: Edl = {
      ...old!.edl,
      overlays: [...old!.edl.overlays, { id: 'o-bad', type: 'broll', assetId: assetKept, anchorSegmentId: 'no-such-segment', offsetSec: 0, durationSec: 1, sourceStartSec: 0 } as Edl['overlays'][number]],
    };
    await env.sql`update edls set edl = ${env.sql.json(broken as never)} where video_id = ${id} and revision = 1`;
    await user.err(400, 'invalid_request', 'POST', `/v1/videos/${id}/edl/restore`, { revision: 1, baseRevision: 5 });
    await env.sql`update edls set edl = ${env.sql.json(old!.edl as never)} where video_id = ${id} and revision = 1`;
    expect((await user.ok(ListEdlVersionsResponse, 'GET', `/v1/videos/${id}/edl/versions`)).current).toBe(5);
  });

  it('a restore takes a done video back to ready_for_review', async () => {
    const { renders } = await user.ok(CreateRenderResponse, 'POST', `/v1/videos/${id}/renders`, { quality: 'final' }, 201);
    await waitFor(async () => {
      const all = await Promise.all(renders.map((r) => user.ok(RenderView, 'GET', `/v1/renders/${r.id}`)));
      return all.every((r) => r.status === 'done');
    }, 'final renders');
    await waitForStatus(user, id, 'done');
    // While rendering or done the stale-base check still comes first.
    await user.err(409, 'revision_conflict', 'POST', `/v1/videos/${id}/edl/restore`, { revision: 0, baseRevision: 4 });
    const res = await user.ok(SaveEdlResponse, 'POST', `/v1/videos/${id}/edl/restore`, { revision: 0, baseRevision: 5 });
    expect(res.edl.revision).toBe(6);
    expect(res.edl.segments).toEqual(at[0]!.segments);
    expect(brollIds(res.edl)).not.toContain(assetGone);
    const video = await user.ok(VideoDetail, 'GET', `/v1/videos/${id}`);
    expect(video.status).toBe('ready_for_review');
    const list = await user.ok(ListEdlVersionsResponse, 'GET', `/v1/videos/${id}/edl/versions`);
    expect(list.versions.slice(0, 2).map((v) => [v.revision, v.author, v.restoredFrom])).toEqual([
      [6, 'user', 0],
      [5, 'user', 3],
    ]);
  });

  it('a video with no edit yet answers 409 invalid_state for its versions', async () => {
    const created = await uploadFixtures(user, ['routine'], { complete: false });
    const pending = created.videos[0]!.videoId;
    await user.err(409, 'invalid_state', 'GET', `/v1/videos/${pending}/edl/versions`);
    await user.err(404, 'not_found', 'GET', `/v1/videos/${pending}/edl/versions/0`);
    await user.err(409, 'invalid_state', 'POST', `/v1/videos/${pending}/edl/restore`, { revision: 0, baseRevision: 0 });
  });
});

describe('migration 006_versions', () => {
  it('applies on a database already migrated through 005, keeping its revisions', async () => {
    const adminUrl = inject('pgAdminUrl');
    const name = `kilo_t_v6_${randomUUID().slice(0, 8)}`;
    const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database "${name}"`);
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    const sql: Sql = connect(url.toString(), { max: 1 });
    const before = mkdtempSync(join(SERVER_DIR, '.work', 'migrations-'));
    try {
      for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && f < '006')) copyFileSync(join(MIGRATIONS_DIR, f), join(before, f));
      expect((await migrate(sql, before)).applied).not.toContain('006_versions.sql');
      const userId = randomUUID();
      const batchId = randomUUID();
      const videoId = randomUUID();
      await sql`insert into batches ${sql({ id: batchId, user_id: userId, settings: sql.json(DEFAULT_SETTINGS as never) })}`;
      await sql`insert into videos ${sql({ id: videoId, user_id: userId, batch_id: batchId, title: 't', source: 'upload', settings: sql.json(DEFAULT_SETTINGS as never) })}`;
      await sql`insert into edls (video_id, revision, user_id, edl, author) values (${videoId}, 0, ${userId}, '{}'::jsonb, 'decider')`;

      const result = await migrate(sql);
      expect(result.applied).toEqual(['006_versions.sql']);
      expect(await sql`select revision, restored_from from edls where video_id = ${videoId}`).toEqual([{ revision: 0, restored_from: null }]);
      await sql`insert into edls (video_id, revision, user_id, edl, author, restored_from) values (${videoId}, 1, ${userId}, '{}'::jsonb, 'user', 0)`;
      // A restore names an earlier revision, never itself or a later one.
      await expect(sql`insert into edls (video_id, revision, user_id, edl, author, restored_from) values (${videoId}, 2, ${userId}, '{}'::jsonb, 'user', 2)`).rejects.toThrow(/edls_restored_from_check/);
      // Running it again changes nothing.
      expect((await migrate(sql)).applied).toEqual([]);
      // and so does applying the file twice by hand (it is idempotent).
      await sql.unsafe(readFileSync(join(MIGRATIONS_DIR, '006_versions.sql'), 'utf8'));
    } finally {
      rmSync(before, { recursive: true, force: true });
      await sql.end();
      await admin.unsafe(`drop database if exists "${name}" with (force)`).catch(() => {});
      await admin.end();
    }
  });
});
