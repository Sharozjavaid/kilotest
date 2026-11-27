// Flow 2: review a real video. The proxy plays over Range requests, the player skips the cut
// ranges, the transcript rows match the server's EDL, a toggle saves and survives a reload, a
// stale save is reconciled after the 409, variants switch, and a rendered preview plays.
import { checkOverlayRules } from '@kilo/edl';
import { assert, bodyText, openApp, samplePlayback, seeText, shot, sleep, waitFor } from '../lib.mjs';

/** Rows the review screen should show: segments with words, or silences of a second or more. */
export function expectedRows(edl) {
  return edl.segments.filter((s) => s.text.trim() || s.end - s.start >= 1).map((s) => s.id);
}

/** Proxy-time ranges a variant (or the base cut) plays, in order. */
export function ranges(edl, offsets, variantId) {
  const kept = edl.segments.filter((s) => s.keep);
  const order = variantId ? edl.variants.find((v) => v.id === variantId).segmentOrder.map((id) => kept.find((s) => s.id === id)).filter(Boolean) : kept;
  return order.map((s) => ({ id: s.id, start: offsets[s.clipId] + s.start, end: offsets[s.clipId] + s.end }));
}

async function rowState(page, segmentId) {
  const label = await page.getByTestId(`row-${segmentId}`).getAttribute('aria-label');
  return /\. Kept/.test(label) ? 'kept' : 'cut';
}

export default async function review(ctx) {
  const videoId = ctx.state.videoIds?.routine;
  assert(videoId, 'needs the upload flow');
  const { page, browser, errors } = await openApp(ctx, { userId: ctx.userId });
  const proxyRequests = [];
  page.on('response', async (r) => {
    if (r.url().includes('/v1/local/file/') && r.request().resourceType() === 'media') proxyRequests.push({ status: r.status(), range: r.request().headers().range ?? null });
  });
  try {
    await seeText(page, 'Ready to review');
    await page.getByRole('button', { name: /^Morning routine, / }).first().click();
    await page.waitForURL(/\/review\//);
    await seeText(page, 'Final length');
    let detail = await ctx.api.video(videoId);
    const edl0 = detail.edl;
    const offsets = detail.proxy.clipOffsets;

    // Transcript rows: the server's segments, in order, with the server's words.
    const rowIds = await page.locator('[data-testid^="row-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid').slice(4)));
    assert(JSON.stringify(rowIds) === JSON.stringify(expectedRows(edl0)), `rows ${rowIds} differ from the EDL's ${expectedRows(edl0)}`);
    for (const s of edl0.segments.filter((x) => x.text.trim())) {
      const label = await page.getByTestId(`row-${s.id}`).getAttribute('aria-label');
      assert(label.startsWith(s.text.trim()), `row ${s.id} reads "${label}", the EDL says "${s.text}"`);
      assert((await rowState(page, s.id)) === (s.keep ? 'kept' : 'cut'), `row ${s.id} shows the wrong state`);
    }
    const finalLen = await page.getByTestId('final-length').innerText();
    ctx.log(`  ${rowIds.length} rows; final length ${finalLen}; ${edl0.variants.length} variants`);
    await shot(page, '07-review');

    // Play the base of variant A and check the cut ranges are skipped.
    await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2, null, { timeout: 30_000 });
    const variantA = edl0.variants[0]?.id ?? null;
    const plays = ranges(edl0, offsets, variantA);
    await page.getByTestId('play').click();
    const keptSec = plays.reduce((n, r) => n + r.end - r.start, 0);
    const sampled = await samplePlayback(page, 'video', Math.min(16_000, keptSec * 1000 - 500));
    assert(!sampled.error, `the proxy failed to play: media error ${sampled.error}`);
    const ts = sampled.samples.map((s) => s.t);
    // It plays to the end of the last kept line, then rewinds to the start.
    assert(Math.max(...ts) > ts[0] + 3, `playback did not advance (${ts[0]} -> max ${Math.max(...ts)})`);
    const last = plays.at(-1);
    assert(Math.max(...ts) <= last.end + 0.2, `played past the last kept line (${Math.max(...ts)} > ${last.end})`);
    const cuts = [];
    for (let i = 1; i < plays.length; i++) if (plays[i].start - plays[i - 1].end > 0.25) cuts.push({ start: plays[i - 1].end, end: plays[i].start });
    const inCut = ts.filter((t) => cuts.some((c) => t > c.start + 0.15 && t < c.end - 0.05));
    assert(inCut.length === 0, `the player played inside cut ranges: ${inCut.slice(0, 5)} (cuts ${JSON.stringify(cuts)})`);
    const jumps = ts.slice(1).filter((t, i) => t - ts[i] > 0.5).length;
    ctx.log(`  played ${ts[0]}..${Math.max(...ts)}s with ${jumps} skips over ${cuts.length} cuts; ${sampled.samples.length} samples, none inside a cut`);
    assert(jumps >= Math.min(1, cuts.length), 'the player never skipped a cut');
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    const ranged = proxyRequests.filter((r) => r.range && r.status === 206);
    assert(ranged.length > 0, `the proxy was not served with Range (requests: ${JSON.stringify(proxyRequests.slice(0, 4))})`);

    // Toggle a cut line back in: it saves, and survives a reload.
    const cutSeg = edl0.segments.find((s) => !s.keep && s.text.trim());
    assert(cutSeg, 'the routine EDL has no cut line to restore');
    const put1 = page.waitForResponse((r) => r.url().endsWith(`/videos/${videoId}/edl`) && r.request().method() === 'PUT');
    await page.getByTestId(`row-${cutSeg.id}`).click();
    assert((await rowState(page, cutSeg.id)) === 'kept', 'the tapped row did not flip');
    const res1 = await put1;
    assert(res1.status() === 200, `PUT /edl answered ${res1.status()}: ${await res1.text()}`);
    await page.reload({ waitUntil: 'networkidle' });
    await seeText(page, 'Final length');
    assert((await rowState(page, cutSeg.id)) === 'kept', 'the restored line is cut again after a reload');
    detail = await ctx.api.video(videoId);
    assert(detail.edl.segments.find((s) => s.id === cutSeg.id).keep, 'the server did not store the toggle');

    // A stale save: someone else saves first; the app's next save gets 409, refetches and replays the tap.
    // A line that no hook depends on (not the opening, not a cold open, not a title's anchor), so the variants stay distinct.
    const hookIds = new Set([
      edl0.segments.find((x) => x.keep)?.id,
      ...edl0.variants.map((v) => v.segmentOrder[0]),
      ...edl0.variants.flatMap((v) => v.overlays.map((o) => o.anchorSegmentId)),
    ]);
    // The other device is a client too: its edit must keep the overlay rules (the app fits overlays
    // after a cut; this stand-in instead picks a line whose cut leaves them intact).
    const cutOther = (seg) => {
      const e = { ...detail.edl, segments: detail.edl.segments.map((s) => (s.id === seg.id ? { ...s, keep: false, userOverride: true } : s)) };
      e.variants = e.variants.map((v) => ({ ...v, segmentOrder: v.segmentOrder.filter((id) => id !== seg.id) }));
      return e;
    };
    const other = detail.edl.segments.find((s) => s.keep && s.text.trim() && s.id !== cutSeg.id && !hookIds.has(s.id) && checkOverlayRules(cutOther(s)).length === 0);
    assert(other, 'no line to cut that leaves the hooks and the overlay rules alone');
    const theirs = cutOther(other);
    await ctx.api.saveEdl(videoId, theirs, detail.edl.revision);
    const srcBefore = await page.evaluate(() => document.querySelector('video').currentSrc);
    const statuses = [];
    const onResp = (r) => {
      if (r.url().endsWith(`/videos/${videoId}/edl`) && r.request().method() === 'PUT') statuses.push(r.status());
    };
    page.on('response', onResp);
    await page.getByTestId(`row-${cutSeg.id}`).click(); // cut it again, on a stale revision
    await waitFor('the stale save to be reconciled', () => statuses.includes(409) && statuses.at(-1) === 200, { timeoutMs: 20_000 });
    page.off('response', onResp);
    detail = await ctx.api.video(videoId);
    assert(!detail.edl.segments.find((s) => s.id === cutSeg.id).keep, 'the tap made on the stale revision was lost');
    assert(!detail.edl.segments.find((s) => s.id === other.id).keep, "the other device's save was overwritten");
    await waitFor('the screen to show both changes', async () => (await rowState(page, other.id)) === 'cut' && (await rowState(page, cutSeg.id)) === 'cut', { timeoutMs: 10_000 });
    ctx.log(`  stale save: ${statuses.join(' -> ')}; server revision ${detail.edl.revision}`);
    // Saves refetch the video (new signed links); the player must keep its source rather than reload.
    const srcAfter = await page.evaluate(() => document.querySelector('video').currentSrc);
    assert(srcAfter === srcBefore, 'the review player reloaded its source after a save');
    assert(!(await bodyText(page)).includes("Couldn't save"), 'the screen shows a save error after reconciling');

    // Variants: switch to Hook B and play: it starts on Hook B's first line.
    const edl = detail.edl;
    if (edl.variants.length > 1) {
      const b = edl.variants[1];
      await page.getByRole('radio', { name: b.label }).click();
      const firstB = ranges(edl, offsets, b.id)[0];
      await page.getByTestId('play').click();
      await sleep(600);
      const t = await page.evaluate(() => document.querySelector('video').currentTime);
      await page.getByTestId('play').click();
      ctx.log(`  ${b.label} (${b.hookText.slice(0, 40)}): starts at ${t.toFixed(2)}s, expected ${firstB.start.toFixed(2)}s`);
      assert(t >= firstB.start - 0.1 && t <= firstB.end, `${b.label} did not start on its first line (at ${t}, wanted ${firstB.start}..${firstB.end})`);
      await shot(page, '08-review-variant');
    }

    // Preview with effects: a real preview render, then it plays.
    await page.getByTestId('preview-effects').click();
    await waitFor('the preview render to finish', async () => {
      const v = await ctx.api.video(videoId);
      const r = v.renders.find((x) => x.quality === 'preview');
      if (r?.status === 'failed') throw new Error(`preview failed: ${r.error}`);
      return r?.status === 'done';
    }, { timeoutMs: 5 * 60_000, everyMs: 1000 });
    await page.waitForFunction(() => document.querySelectorAll('video').length >= 2, null, { timeout: 20_000 });
    const preview = await samplePlayback(page, 'video:last-of-type', 2500).catch(() => null);
    const pv = await page.evaluate(async () => {
      const vids = [...document.querySelectorAll('video')];
      const v = vids[vids.length - 1];
      const t0 = v.currentTime;
      await new Promise((r) => setTimeout(r, 2000));
      return { t0, t1: v.currentTime, w: v.videoWidth, h: v.videoHeight, err: v.error?.code ?? null };
    });
    void preview;
    ctx.log(`  preview plays: ${pv.t0.toFixed(2)} -> ${pv.t1.toFixed(2)}s at ${pv.w}x${pv.h}`);
    assert(!pv.err && pv.t1 > pv.t0, `the preview did not play (${JSON.stringify(pv)})`);
    await shot(page, '09-preview');
    await page.getByRole('button', { name: 'Close player' }).click();
    assert(!errors.length, `browser errors: ${errors.slice(0, 5).join(' | ')}`);
  } finally {
    await browser.close();
  }
}
