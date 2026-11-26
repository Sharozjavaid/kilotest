// Flow 4: "Looks good" -> final renders for every variant with progress -> each plays -> the
// files download (bytes arrive; ffprobe: 1080x1920 at the EDL's frame rate) -> mark as posted
// -> the weekly goal count on Home goes up -> "Next video".
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { WORK, assert, bodyText, ffprobe, openApp, rate, seeText, shot, waitFor } from '../lib.mjs';

export default async function exportFlow(ctx) {
  const videoId = ctx.state.videoIds?.routine;
  assert(videoId, 'needs the upload flow');
  // A goal, so Home shows a count that can go up.
  const goal = await ctx.api.call('PUT', '/goal', { videosPerWeek: 3, reminder: { enabled: false, hour: 18, timeZone: 'UTC' } });
  const postedBefore = goal.postedThisWeek;
  const { page, browser, errors } = await openApp(ctx, { userId: ctx.userId });
  try {
    await seeText(page, `${postedBefore} of 3 videos posted`);
    await page.getByRole('button', { name: /^Morning routine, / }).first().click();
    await seeText(page, 'Final length');
    await page.getByTestId('looks-good').click();
    await page.waitForURL(/\/export\//);
    const detail0 = await ctx.api.video(videoId);
    const edl = detail0.edl;
    const n = Math.max(1, edl.variants.length);

    // Final renders for every variant, with progress on the tiles.
    const seen = new Set();
    let shotTaken = false;
    await waitFor('every final render to finish', async () => {
      for (const m of (await bodyText(page)).matchAll(/Exporting (\d+)%/g)) seen.add(Number(m[1]));
      if (!shotTaken && seen.size) {
        shotTaken = true;
        await shot(page, '14-export-rendering');
      }
      const v = await ctx.api.video(videoId);
      const finals = v.renders.filter((r) => r.quality === 'final');
      const bad = finals.find((r) => r.status === 'failed');
      if (bad) throw new Error(`final render failed: ${bad.error}`);
      return finals.length >= n && finals.every((r) => r.status === 'done') && v.status === 'done';
    }, { timeoutMs: 15 * 60_000, everyMs: 700 });
    ctx.log(`  ${n} final renders; progress shown: ${[...seen].sort((a, b) => a - b).join(',')}%`);
    assert([...seen].some((p) => p > 0 && p < 100), 'the export screen never showed render progress between 0 and 100%');
    const ready = page.getByRole('button', { name: /\. Tap to play$/ });
    await waitFor('every version tile to show ready', async () => (await ready.count()) === n, { timeoutMs: 30_000 });
    await shot(page, '15-export-done');

    // Each version plays.
    const labels = edl.variants.length ? edl.variants.map((v) => v.label) : ['Final cut'];
    for (const label of labels) {
      await page.getByRole('button', { name: new RegExp(`^${label}, .*Tap to play`) }).click();
      await page.waitForFunction(() => document.querySelectorAll('video').length >= 1, null, { timeout: 15_000 });
      const pv = await page.evaluate(async () => {
        const v = [...document.querySelectorAll('video')].at(-1);
        const t0 = v.currentTime;
        await new Promise((r) => setTimeout(r, 1500));
        return { t0, t1: v.currentTime, w: v.videoWidth, h: v.videoHeight, err: v.error?.code ?? null };
      });
      assert(!pv.err && pv.t1 > pv.t0 && pv.w === 1080 && pv.h === 1920, `${label} did not play at 1080x1920: ${JSON.stringify(pv)}`);
      if (label === labels[0]) await shot(page, '16-export-playing');
      await page.getByRole('button', { name: 'Close player' }).click();
      await page.getByRole('button', { name: 'Close player' }).waitFor({ state: 'detached', timeout: 10_000 });
      const left = await page.evaluate(() => [...document.querySelectorAll('video')].filter((v) => !v.paused).length);
      assert(left === 0, `a closed player keeps playing (${left})`);
    }

    // Save all: on web each version downloads; check the bytes and the format.
    const dir = join(WORK, 'downloads');
    mkdirSync(dir, { recursive: true });
    const downloads = [];
    const onDownload = (d) => downloads.push(d);
    page.on('download', onDownload);
    await page.getByRole('button', { name: n > 1 ? `Download all ${n}` : 'Download', exact: true }).click();
    await waitFor(`${n} downloads`, () => downloads.length >= n, { timeoutMs: 60_000 });
    page.off('download', onDownload);
    assert(page.url().includes('/export/'), `saving navigated away from the app to ${page.url()}`);
    const hashes = new Set();
    for (const d of downloads) {
      const path = join(dir, d.suggestedFilename());
      await d.saveAs(path);
      const size = statSync(path).size;
      const p = await ffprobe(path);
      const v = p.streams.find((s) => s.codec_type === 'video');
      const fps = rate(v.avg_frame_rate);
      ctx.log(`  ${d.suggestedFilename()}: ${size} bytes, ${v.width}x${v.height} @ ${fps.toFixed(2)} fps, ${Number(p.format.duration).toFixed(2)}s`);
      assert(size > 10_000, `${d.suggestedFilename()} is only ${size} bytes`);
      assert(v.width === 1080 && v.height === 1920, `${d.suggestedFilename()} is ${v.width}x${v.height}`);
      assert(Math.abs(fps - edl.fps) < 0.05, `${d.suggestedFilename()} is ${fps} fps, the EDL says ${edl.fps}`);
      hashes.add(createHash('md5').update(readFileSync(path)).digest('hex'));
    }
    assert(hashes.size === downloads.length, `the ${n} versions are not distinct files (${hashes.size} different)`);

    // Mark as posted; Home's goal count goes up.
    await page.getByRole('button', { name: 'I posted this, mark as posted' }).click();
    await seeText(page, 'Marked as posted');
    await shot(page, '17-export-posted');
    const after = await ctx.api.goal();
    assert(after.postedThisWeek === postedBefore + 1, `postedThisWeek ${postedBefore} -> ${after.postedThisWeek}`);

    // Next video goes to the next one in the batch.
    const next = (await ctx.api.batch(detail0.batchId)).videos.findIndex((v) => v.id === videoId) + 2;
    await page.getByRole('button', { name: new RegExp(`^Next video, ${next} of 3`) }).click();
    const nextVideo = (await ctx.api.batch(detail0.batchId)).videos[next - 1];
    await page.waitForURL((u) => u.pathname.includes(nextVideo.id), { timeout: 15_000 });
    assert(new URL(page.url()).pathname === `/review/${nextVideo.id}`, `next video opened ${page.url()}, expected the review of ${nextVideo.title}`);
    ctx.log(`  next video -> ${new URL(page.url()).pathname}`);
    await page.goto(ctx.appUrl + '/', { waitUntil: 'networkidle' });
    await seeText(page, `${postedBefore + 1} of 3 videos posted`);
    await seeText(page, 'Finished');
    await shot(page, '18-home-after-post');
    assert(!errors.length, `browser errors: ${errors.slice(0, 5).join(' | ')}`);
  } finally {
    await browser.close();
  }
}
