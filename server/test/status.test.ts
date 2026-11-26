import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CreateRenderResponse,
  RenderView,
  SaveEdlResponse,
  VideoDetail,
  VideoSummary,
  toggleSegment,
  type AnalyzeApi,
  type RenderApi,
} from '@kilo/edl';
import { createFakePipeline } from '../src/pipeline/fake.js';
import type { Pipeline } from '../src/pipeline/types.js';
import { createEnv, fixturePath, newUser, settings, uploadFixtures, waitFor, waitForStatus, type Client, type TestEnv } from './helpers.js';

type Faults = Partial<Record<keyof AnalyzeApi | 'renderVideo', ((...args: never[]) => unknown) | undefined>>;

/** The fake pipeline with call counters and switchable faults. */
function controllable(stockUrl?: string) {
  const base = createFakePipeline({
    stockCandidates: stockUrl ? [{ downloadUrl: stockUrl, kind: 'image', attribution: 'Photo by Test on Example', query: 'stopwatch' }] : [],
  });
  const calls: Record<string, number> = {};
  const faults: Faults = {};
  const analyze = Object.fromEntries(
    Object.entries(base.analyze).map(([name, fn]) => [
      name,
      async (input: unknown) => {
        calls[name] = (calls[name] ?? 0) + 1;
        const fault = faults[name as keyof AnalyzeApi];
        if (fault) {
          const replaced = await (fault as (i: unknown) => unknown)(input);
          if (replaced !== undefined) return replaced;
        }
        return (fn as (i: unknown) => unknown)(input);
      },
    ]),
  ) as unknown as AnalyzeApi;
  const render: RenderApi = {
    async renderVideo(input) {
      calls.renderVideo = (calls.renderVideo ?? 0) + 1;
      if (faults.renderVideo) await (faults.renderVideo as (i: unknown) => unknown)(input);
      return base.render.renderVideo(input);
    },
  };
  const pipeline: Pipeline = { analyze, render, templates: base.templates };
  return { pipeline, calls, faults, reset: () => Object.keys(calls).forEach((k) => delete calls[k]) };
}

describe('video status machine', () => {
  let env: TestEnv;
  let user: Client;
  let ctl: ReturnType<typeof controllable>;

  beforeAll(async () => {
    ctl = controllable(pathToFileURL(fixturePath('routine', 'broll/stopwatch.jpg')).toString());
    env = await createEnv({ pipeline: ctl.pipeline });
    user = env.as(newUser());
  });
  afterAll(async () => {
    await env?.stop();
  });

  it('a failed step fails the video with a safe message, and retry resumes without redoing finished steps', async () => {
    ctl.reset();
    let failDecide = true;
    ctl.faults.decideEdit = () => {
      if (failDecide) throw new Error('decider exploded at /secret/path/key=sk-123');
      return undefined;
    };
    const created = await uploadFixtures(user, ['mistakes']);
    const id = created.videos[0]!.videoId;
    const failed = await waitForStatus(user, id, 'failed');
    expect(failed.error).toBe('We could not build an edit for this video. Try again.');
    expect(failed.error).not.toContain('secret');
    // Ingest finished before the failure: clips, transcripts and proxy are stored.
    expect(failed.clips).toHaveLength(2);
    expect(failed.transcripts).toHaveLength(2);
    expect(failed.proxy).not.toBeNull();
    expect(env.log.lines.some((l) => l.level === 'error' && JSON.stringify(l.fields).includes('decider exploded'))).toBe(true);
    await waitFor(async () => env.push.sent.some((s) => s.message.data.type === 'video_failed'), 'video_failed push');
    // A batch whose only video failed never sends batch_ready.
    expect(env.push.sent.some((s) => s.message.data.type === 'batch_ready' && s.message.data.batchId === created.batch.id)).toBe(false);
    expect(ctl.calls).toMatchObject({ ingestClip: 2, transcribeClip: 2, detectSilence: 2, buildConcatProxy: 1, decideEdit: 1 });

    failDecide = false;
    const retried = await user.ok(VideoSummary, 'POST', `/v1/videos/${id}/retry`);
    expect(retried.status).toBe('queued');
    expect(retried.error).toBeNull();
    const ready = await waitForStatus(user, id, 'ready_for_review');
    expect(ready.edl!.revision).toBe(0);
    expect(ctl.calls).toMatchObject({ ingestClip: 2, transcribeClip: 2, detectSilence: 2, buildConcatProxy: 1, decideEdit: 2 });
    await user.err(409, 'invalid_state', 'POST', `/v1/videos/${id}/retry`);
    ctl.faults.decideEdit = undefined;
  });

  it('a job cut short by shutdown is queued again, not failed as a bad clip', async () => {
    let stops = 1;
    ctl.faults.ingestClip = () => {
      if (stops-- > 0) throw Object.assign(new Error('ffprobe not started: received SIGTERM'), { name: 'MediaStoppedError' });
      return undefined;
    };
    const a = await uploadFixtures(user, ['routine']);
    const ready = await waitForStatus(user, a.videos[0]!.videoId, 'ready_for_review', 60_000);
    expect(ready.error).toBeNull();
    expect(env.log.lines.some((l) => l.msg.includes('interrupted by shutdown'))).toBe(true);
    ctl.faults.ingestClip = undefined;
  });

  it('an unreadable clip fails with the bad-clip message; an invalid EDL from the decider is refused', async () => {
    ctl.faults.ingestClip = () => {
      throw new Error('ffmpeg: moov atom not found');
    };
    const a = await uploadFixtures(user, ['routine']);
    const failed = await waitForStatus(user, a.videos[0]!.videoId, 'failed');
    expect(failed.error).toBe('One of the clips could not be read. Check that it is a video file.');
    ctl.faults.ingestClip = undefined;

    ctl.faults.decideEdit = async (input: { videoId: string }) => {
      const edl = await createFakePipeline().analyze.decideEdit(input as never);
      return { ...edl, segments: edl.segments.slice(1) }; // leaves a gap
    };
    const b = await uploadFixtures(user, ['routine']);
    const bad = await waitForStatus(user, b.videos[0]!.videoId, 'failed');
    expect(bad.error).toBe('We could not build an edit for this video. Try again.');
    expect(bad.edl).toBeNull();
    ctl.faults.decideEdit = undefined;
  });

  it('replan goes analyzing → ready_for_review, keeps cuts and user overrides, and bumps the revision', async () => {
    const created = await uploadFixtures(user, ['routine'], { settings: settings({ hookVariations: 1 }) });
    const id = created.videos[0]!.videoId;
    const ready = await waitForStatus(user, id, 'ready_for_review');
    const cut = ready.edl!.segments.find((s) => !s.keep && s.text)!;
    const saved = await user.ok(SaveEdlResponse, 'PUT', `/v1/videos/${id}/edl`, { edl: toggleSegment(ready.edl!, cut.id), baseRevision: 0 });
    expect(saved.edl.variants).toEqual([]);
    // A client cannot change the settings an edit was made with; they stay as stored.
    const withVariants = { ...saved.edl, settings: { ...saved.edl.settings, hookVariations: 3 } };
    const kept = await user.ok(SaveEdlResponse, 'PUT', `/v1/videos/${id}/edl`, { edl: withVariants, baseRevision: 1 });
    expect(kept.edl.settings.hookVariations).toBe(1);
    // Ask for variants by changing the stored settings, then replan only that pass.
    await env.sql`update edls set edl = jsonb_set(edl, '{settings,hookVariations}', '3') where video_id = ${id} and revision = 2`;
    const saved2 = { edl: { ...kept.edl, settings: { ...kept.edl.settings, hookVariations: 3 } } };
    let gate!: () => void;
    const hold = new Promise<void>((r) => (gate = r));
    ctl.faults.replan = async () => {
      await hold;
      return undefined;
    };
    const started = await user.ok(VideoSummary, 'POST', `/v1/videos/${id}/replan`, { passes: ['variants'] });
    expect(started.status).toBe('analyzing');
    // While replanning, the edit is locked.
    await user.err(409, 'invalid_state', 'PUT', `/v1/videos/${id}/edl`, { edl: saved2.edl, baseRevision: 2 });
    await user.err(409, 'invalid_state', 'POST', `/v1/videos/${id}/replan`, { passes: ['broll'] });
    await user.err(409, 'invalid_state', 'POST', `/v1/videos/${id}/renders`, { quality: 'final' });
    gate();
    const after = await waitForStatus(user, id, 'ready_for_review');
    ctl.faults.replan = undefined;
    expect(after.edl!.revision).toBe(3);
    expect(after.edl!.variants.length).toBe(3);
    expect(after.variantCount).toBe(3);
    expect(after.edl!.segments.map((s) => [s.id, s.keep, s.userOverride])).toEqual(
      saved2.edl.segments.map((s) => [s.id, s.keep, s.userOverride]),
    );

    // A replan that flips a cut is refused and fails the video; retry brings it back.
    ctl.faults.replan = async (input: { edl: { segments: { keep: boolean }[] } }) => ({
      ...input.edl,
      segments: input.edl.segments.map((s) => ({ ...s, keep: true })),
    });
    await user.ok(VideoSummary, 'POST', `/v1/videos/${id}/replan`, { passes: ['graphics'] });
    const failed = await waitForStatus(user, id, 'failed');
    expect(failed.error).toBe('Updating the edit failed. Try again.');
    ctl.faults.replan = undefined;
    await user.ok(VideoSummary, 'POST', `/v1/videos/${id}/retry`);
    const back = await waitForStatus(user, id, 'ready_for_review');
    expect(back.edl!.revision).toBe(3);
  });

  it('rendering → done → (edl saved) → ready_for_review; final render failure fails the video', async () => {
    const created = await uploadFixtures(user, ['routine'], { settings: settings({ hookVariations: 2 }) });
    const id = created.videos[0]!.videoId;
    const ready = await waitForStatus(user, id, 'ready_for_review');
    expect(ready.edl!.variants).toHaveLength(2);
    // Omitting variantIds renders every variant.
    const renders = await user.ok(CreateRenderResponse, 'POST', `/v1/videos/${id}/renders`, { quality: 'final' }, 201);
    expect(renders.renders.map((r) => r.variantId)).toEqual(ready.edl!.variants.map((v) => v.id));
    const done = await waitForStatus(user, id, 'done');
    expect(done.renders.every((r) => r.status === 'done')).toBe(true);
    const saved = await user.ok(SaveEdlResponse, 'PUT', `/v1/videos/${id}/edl`, {
      edl: toggleSegment(done.edl!, done.edl!.segments.find((s) => !s.keep)!.id),
      baseRevision: 0,
    });
    expect(saved.edl.revision).toBe(1);
    expect((await user.ok(VideoDetail, 'GET', `/v1/videos/${id}`)).status).toBe('ready_for_review');

    ctl.faults.renderVideo = () => {
      throw new Error('ffmpeg exited with code 1: filter graph /tmp/x');
    };
    const bad = await user.ok(CreateRenderResponse, 'POST', `/v1/videos/${id}/renders`, { quality: 'final', variantIds: [null] }, 201);
    const failedRender = await waitFor(async () => {
      const r = await user.ok(RenderView, 'GET', `/v1/renders/${bad.renders[0]!.id}`);
      return r.status === 'failed' ? r : null;
    }, 'render to fail');
    expect(failedRender.error).toBe('The export failed. Try again.');
    expect(failedRender.url).toBeNull();
    const failed = await waitForStatus(user, id, 'failed');
    expect(failed.error).toBe('The export failed. Try again.');
    ctl.faults.renderVideo = undefined;
    await user.ok(VideoSummary, 'POST', `/v1/videos/${id}/retry`);
    await waitForStatus(user, id, 'ready_for_review');

    // A failed preview does not touch the video.
    ctl.faults.renderVideo = () => {
      throw new Error('boom');
    };
    const preview = await user.ok(CreateRenderResponse, 'POST', `/v1/videos/${id}/renders`, { quality: 'preview', variantIds: [null] }, 201);
    await waitFor(async () => (await user.ok(RenderView, 'GET', `/v1/renders/${preview.renders[0]!.id}`)).status === 'failed', 'preview to fail');
    expect((await user.ok(VideoDetail, 'GET', `/v1/videos/${id}`)).status).toBe('ready_for_review');
    ctl.faults.renderVideo = undefined;
  });

  it('stock B-roll is downloaded, ingested and passed to the decider when enabled', async () => {
    ctl.reset();
    const created = await uploadFixtures(user, ['routine'], { settings: settings({ stockBroll: true }) });
    const v = await waitForStatus(user, created.videos[0]!.videoId, 'ready_for_review');
    const stock = v.broll.filter((b) => b.source === 'stock');
    expect(stock).toHaveLength(1);
    expect(stock[0]).toMatchObject({ status: 'ready', attribution: 'Photo by Test on Example', kind: 'image' });
    expect(v.edl!.overlays.some((o) => o.type === 'broll' && o.assetId === stock[0]!.id)).toBe(true);
    expect(ctl.calls.suggestStockBroll).toBe(1);
  });
});

describe('automatic job retries', () => {
  let env: TestEnv;
  let ctl: ReturnType<typeof controllable>;

  beforeAll(async () => {
    ctl = controllable();
    env = await createEnv({ pipeline: ctl.pipeline, retryLimit: 1 });
  });
  afterAll(async () => {
    await env?.stop();
  });

  it('a transient failure is retried by the queue and the video never shows failed', async () => {
    const user = env.as(newUser());
    let failures = 1;
    ctl.faults.transcribeClip = () => {
      if (failures-- > 0) throw new Error('provider timeout');
      return undefined;
    };
    const created = await uploadFixtures(user, ['routine']);
    const id = created.videos[0]!.videoId;
    const ready = await waitForStatus(user, id, 'ready_for_review');
    expect(ready.transcripts).toHaveLength(1);
    // The retry reused the ingested clip from the first attempt.
    expect(ctl.calls.ingestClip).toBe(1);
    expect(ctl.calls.transcribeClip).toBe(2);
    expect(env.log.lines.filter((l) => l.msg === 'job failed')).toHaveLength(1);
  });
});
