// Flow: version history and compare. Open a ready video that nobody has edited yet (the unboxing
// one: later flows use it, and the restore leaves its edit as the decider made it), cut a line,
// open Versions and see two revisions, compare them in step (play a moment, the change list shows
// the cut), restore the first one, and see the original edit back with a third revision,
// "Restored v<first>".
import { assert, openApp, seeText, shot, sleep, waitFor } from '../lib.mjs';

async function rowState(page, segmentId) {
  const label = await page.getByTestId(`row-${segmentId}`).getAttribute('aria-label');
  return /\. Kept/.test(label) ? 'kept' : 'cut';
}

async function openVersions(page) {
  await page.getByTestId('review-menu').locator('visible=true').first().click();
  await page.getByTestId('menu-versions').click();
  await page.waitForURL(/\/versions\//);
  await page.getByTestId('version-list').locator('visible=true').waitFor();
}

const visibleRows = (page) => page.locator('[data-testid^="version-row-"]').locator('visible=true');

export default async function versions(ctx) {
  const videoId = ctx.state.videoIds?.unboxing;
  assert(videoId, 'needs the upload flow');
  const { page, browser, errors } = await openApp(ctx, { userId: ctx.userId, path: `/review/${videoId}` });
  try {
    await seeText(page, 'Final length');
    const before = await ctx.api.call('GET', `/videos/${videoId}/edl/versions`);
    assert(before.versions.length === 1, `the unboxing video already has ${before.versions.length} versions`);
    const first = before.current;
    const edl0 = (await ctx.api.video(videoId)).edl;

    // 1-2. Cut a kept line that no opening or overlay depends on.
    const openings = new Set([edl0.segments.find((s) => s.keep)?.id, ...edl0.variants.map((v) => v.segmentOrder[0])]);
    const anchors = new Set([...edl0.overlays.map((o) => o.anchorSegmentId), ...edl0.variants.flatMap((v) => v.overlays.map((o) => o.anchorSegmentId))]);
    // Early in the order Review plays (the first opening's), so playing on from the cut has seconds to go.
    const played = edl0.variants[0]?.segmentOrder ?? edl0.segments.filter((s) => s.keep).map((s) => s.id);
    // A line with no overlay if there is one (the app fits overlays after a cut, but the list is simpler without).
    const lines = played
      .slice(0, -1)
      .map((id) => edl0.segments.find((s) => s.id === id))
      .filter((s) => s && s.keep && s.text.trim() && !openings.has(s.id));
    const line = lines.find((s) => !anchors.has(s.id)) ?? lines[0];
    assert(line, 'no kept line to cut other than the openings and the last one');
    const put = page.waitForResponse((r) => r.url().endsWith(`/videos/${videoId}/edl`) && r.request().method() === 'PUT');
    await page.getByTestId(`row-${line.id}`).click();
    assert((await rowState(page, line.id)) === 'cut', 'the tapped row did not flip to cut');
    const res = await put;
    assert(res.status() === 200, `PUT /edl answered ${res.status()}: ${await res.text()}`);

    // 3. Versions: two revisions, newest first, the new one current and made by "You".
    await openVersions(page);
    await waitFor('two versions in the list', async () => (await visibleRows(page).count()) === 2, { timeoutMs: 10_000, everyMs: 200 });
    const ids = await visibleRows(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
    const second = first + 1;
    assert(JSON.stringify(ids) === JSON.stringify([`version-row-${second}`, `version-row-${first}`]), `version rows ${ids}`);
    const newest = await page.getByTestId(`version-row-${second}`).getAttribute('aria-label');
    assert(/^v\d+, You, /.test(newest) && /Current$/.test(newest) && /1 cut/.test(newest), `the newest row reads "${newest}"`);
    const oldest = await page.getByTestId(`version-row-${first}`).getAttribute('aria-label');
    assert(/AI edit/.test(oldest) && /First edit/.test(oldest), `the first row reads "${oldest}"`);
    ctx.log(`  versions: ${newest} | ${oldest}`);
    await shot(page, '10a-versions');

    // 4. Compare the first with the current one: two players, the change list shows the cut.
    await page.getByTestId(`version-row-${first}`).click();
    await page.waitForURL(/\/compare\//);
    await page.getByTestId('change-list').locator('visible=true').waitFor();
    const cutRow = page.getByTestId('change-cut').locator('visible=true');
    await cutRow.first().waitFor({ timeout: 10_000 });
    const cutLabel = await cutRow.first().getAttribute('aria-label');
    assert((await cutRow.count()) === 1 && cutLabel.startsWith('Cut ') && cutLabel.includes(line.text.trim().slice(0, 20)), `the change list shows "${cutLabel}" (${await cutRow.count()} cuts) for the cut of "${line.text}"`);
    assert((await page.getByTestId('compare-mark-cut').locator('visible=true').count()) === 1, 'the scrub bar has no mark for the cut');
    await page.waitForFunction(() => [...document.querySelectorAll('video')].filter((v) => v.offsetParent !== null && v.readyState >= 2).length >= 2, null, { timeout: 30_000 });

    // Seek both to the cut, play a moment: both advance, in step through mapTime.
    await cutRow.first().click();
    // The newer version lost the footage there: it says so on its player.
    await page.getByTestId('compare-newer-cut-hint').locator('visible=true').waitFor({ timeout: 2000 });
    await page.getByTestId('compare-play').locator('visible=true').click();
    const samples = await page.evaluate(async () => {
      const vids = [...document.querySelectorAll('video')].filter((v) => v.offsetParent !== null);
      const out = [];
      for (let i = 0; i < 16; i++) {
        out.push(vids.map((v) => ({ t: +v.currentTime.toFixed(3), paused: v.paused })));
        await new Promise((r) => setTimeout(r, 100));
      }
      return out;
    });
    await page.getByTestId('compare-play').locator('visible=true').click();
    // Progress up to the first rewind (a player that reaches the end goes back to the start).
    const advanced = (k) => {
      let best = 0;
      for (let i = 1; i < samples.length && samples[i][k].t >= samples[i - 1][k].t; i++) best = samples[i][k].t - samples[0][k].t;
      return best;
    };
    ctx.log(`  compare played: older ${samples.map((x) => x[0].t).join(' ')}; newer ${samples.map((x) => x[1].t).join(' ')}`);
    assert(advanced(1) > 0.8, `the current version did not play (${advanced(1).toFixed(2)}s)`);
    assert(advanced(0) > 0.8, `the older version did not follow (${advanced(0).toFixed(2)}s)`);
    // Played across the cut, the two play the same footage again: both proxies at the same source time.
    await sleep(300);
    const [oe, ne] = await page.evaluate(() => [...document.querySelectorAll('video')].filter((v) => v.offsetParent !== null).map((v) => v.currentTime));
    assert(Math.abs(oe - ne) <= 0.35, `the players are out of step when paused: older ${oe}, newer ${ne}`);
    await shot(page, '10b-compare');

    // 5. Restore the first version.
    const restoreBtn = page.getByTestId('restore-version').locator('visible=true');
    assert((await restoreBtn.innerText()).includes(`Restore v${first}`), `the button says "${await restoreBtn.innerText()}"`);
    const posted = page.waitForResponse((r) => r.url().endsWith(`/videos/${videoId}/edl/restore`) && r.request().method() === 'POST');
    await restoreBtn.click();
    const rr = await posted;
    assert(rr.status() === 200, `POST /edl/restore answered ${rr.status()}: ${await rr.text()}`);
    await seeText(page, `Restored v${first}`);

    // 6. Back on Review with the original edit; the list has three, the newest "Restored v<first>".
    await page.waitForURL(/\/review\//);
    await seeText(page, 'Final length');
    await waitFor('the review to show the original edit', async () => (await rowState(page, line.id)) === 'kept', { timeoutMs: 10_000, everyMs: 200 });
    const after = (await ctx.api.video(videoId)).edl;
    assert(after.revision === second + 1, `the restore stored revision ${after.revision}`);
    assert(JSON.stringify(after.segments.map((s) => s.keep)) === JSON.stringify(edl0.segments.map((s) => s.keep)), 'the restored edit differs from the first one');
    await openVersions(page);
    await waitFor('three versions in the list', async () => (await visibleRows(page).count()) === 3, { timeoutMs: 10_000, everyMs: 200 });
    const top = await visibleRows(page).first().getAttribute('aria-label');
    assert(top.startsWith(`v${second + 1}, Restored v${first}, `) && top.endsWith('Current'), `the newest row reads "${top}"`);
    ctx.log(`  restored: ${top}`);
    await shot(page, '10c-versions-restored');
    assert(!errors.length, `browser errors: ${errors.slice(0, 5).join(' | ')}`);
  } finally {
    await browser.close();
  }
}
