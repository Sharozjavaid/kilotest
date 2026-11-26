// Flow 3: the B-roll screen with the server's real placements and thumbnails. Swap a B-roll for
// a motion graphic with edited text, add a new B-roll file, upload it, "Place them for me" and
// follow the replan back to ready, remove an asset. The stored EDL still satisfies the server.
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { FIXTURES, assert, openApp, seeText, shot, waitFor } from '../lib.mjs';
import { choose } from './upload.mjs';

const require = createRequire(import.meta.url);
const { checkOverlayRules, validateEdl, resolveTimeline } = require('@kilo/edl');

function soundEdl(detail) {
  const issues = [...validateEdl(detail.edl, detail.clips), ...checkOverlayRules(detail.edl)];
  assert(!issues.length, `the stored EDL breaks the rules: ${issues.map((i) => i.message).join('; ')}`);
}

export default async function broll(ctx) {
  const videoId = ctx.state.videoIds?.unboxing;
  assert(videoId, 'needs the upload flow');
  const { page, browser, errors } = await openApp(ctx, { userId: ctx.userId, path: `/review/${videoId}` });
  try {
    await seeText(page, 'Final length');
    await page.getByRole('button', { name: 'B-roll', exact: true }).click();
    await page.waitForURL(/\/broll\//);
    let detail = await ctx.api.video(videoId);
    await seeText(page, `${detail.broll.length} clips added`);

    // The server's placements: one card per base overlay on a kept line, with real thumbnails.
    const placed = resolveTimeline({ ...detail.edl, variants: [] }).overlays.map((o) => o.overlay);
    for (const o of placed) await page.getByTestId(`swap-${o.id}`).waitFor();
    const brollPlaced = placed.filter((o) => o.type === 'broll');
    assert(brollPlaced.length > 0, 'the server placed no B-roll on the unboxing video');
    await page.waitForFunction(
      (n) => [...document.querySelectorAll('img')].filter((i) => i.src.includes('/v1/local/file/') && i.complete && i.naturalWidth > 0).length >= n,
      detail.broll.length + brollPlaced.length,
      { timeout: 20_000 },
    );
    for (const a of detail.broll) {
      assert(a.status === 'ready' && a.thumbnailUrl && a.description, `asset ${a.filename} is not ready with a thumbnail and description`);
      await seeText(page, a.description);
    }
    ctx.log(`  ${placed.length} placements (${brollPlaced.length} B-roll), ${detail.broll.length} assets: ${detail.broll.map((a) => `${a.filename} "${a.description}"`).join(', ')}`);
    await shot(page, '10-broll');

    // Swap a B-roll for a bold title with our own words.
    const target = brollPlaced[0];
    await page.getByTestId(`swap-${target.id}`).click();
    await page.getByTestId('template-bold-title').click();
    await page.getByTestId('field-text').fill('Desk sorted in two minutes');
    await shot(page, '11-broll-swap-sheet');
    const put = page.waitForResponse((r) => r.url().endsWith(`/videos/${videoId}/edl`) && r.request().method() === 'PUT', { timeout: 20_000 });
    await page.getByTestId('overlay-apply').click();
    const putRes = await put;
    assert(putRes.status() === 200, `saving the swap answered ${putRes.status()}: ${await putRes.text()}`);
    detail = await ctx.api.video(videoId);
    const swapped = detail.edl.overlays.find((o) => o.id === target.id);
    assert(swapped?.type === 'graphic' && swapped.template === 'bold-title' && swapped.props.text === 'Desk sorted in two minutes', `the swap was not stored: ${JSON.stringify(swapped)}`);
    soundEdl(detail);

    // Add a new B-roll file: it uploads, is ingested, then "Place them for me" replans.
    const newFile = join(FIXTURES, 'routine', 'broll', 'shelf.mp4');
    await choose(page, () => page.getByTestId('add-clips').click(), [newFile]);
    await waitFor('the new clip to be ready', async () => {
      const v = await ctx.api.video(videoId);
      const a = v.broll.find((x) => x.filename === 'shelf.mp4');
      if (a?.status === 'failed') throw new Error('the new B-roll failed to ingest');
      return a?.status === 'ready';
    }, { timeoutMs: 120_000, everyMs: 1000 });
    await page.getByTestId('place-them').waitFor({ timeout: 20_000 });
    await shot(page, '12-broll-new-clip');
    const revBefore = (await ctx.api.video(videoId)).edl.revision;
    await page.getByTestId('place-them').click();
    const statuses = new Set();
    await waitFor('the replan to finish', async () => {
      const v = await ctx.api.video(videoId);
      statuses.add(v.status);
      if (v.status === 'failed') throw new Error(`replan failed: ${v.error}`);
      return v.status === 'ready_for_review' && v.edl.revision > revBefore;
    }, { timeoutMs: 180_000, everyMs: 500 });
    await page.getByTestId('replanning').waitFor({ state: 'detached', timeout: 20_000 });
    detail = await ctx.api.video(videoId);
    const shelf = detail.broll.find((x) => x.filename === 'shelf.mp4');
    const shelfPlaced = detail.edl.overlays.some((o) => o.type === 'broll' && o.assetId === shelf.id);
    ctx.log(`  replan: ${[...statuses].join(' -> ')}; new clip placed: ${shelfPlaced}; revision ${revBefore} -> ${detail.edl.revision}`);
    assert(detail.edl.overlays.some((o) => o.id === target.id && o.type === 'graphic'), 'the replan dropped the graphic the creator chose');
    soundEdl(detail);
    await shot(page, '13-broll-replanned');

    // Remove an asset: its overlays go with it.
    const victim = detail.broll.find((a) => a.filename === 'desk_before.jpg') ?? detail.broll[0];
    await page.getByTestId(`delete-${victim.id}`).click();
    await waitFor('the asset to be removed', async () => !(await ctx.api.video(videoId)).broll.some((a) => a.id === victim.id), { timeoutMs: 20_000 });
    await page.getByTestId(`bin-${victim.id}`).waitFor({ state: 'detached', timeout: 20_000 });
    detail = await ctx.api.video(videoId);
    assert(!detail.edl.overlays.some((o) => o.type === 'broll' && o.assetId === victim.id), 'an overlay still uses the removed asset');
    soundEdl(detail);

    // Done saves anything pending; the EDL is still one the server accepts.
    await page.getByTestId('broll-done').click();
    await page.waitForURL(/\/review\//);
    detail = await ctx.api.video(videoId);
    soundEdl(detail);
    assert(!errors.length, `browser errors: ${errors.slice(0, 5).join(' | ')}`);
  } finally {
    await browser.close();
  }
}
