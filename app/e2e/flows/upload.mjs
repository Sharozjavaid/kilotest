// Flow 1: first launch, New batch through the real picker, merge clips into three videos,
// B-roll for two of them, a mode and three hooks, uploads with progress, analysis progress,
// all three ready to review, and Home showing the batch's videos.
import { join } from 'node:path';
import { FIXTURES, assert, bodyText, openApp, seeText, shot, sleep, waitFor } from '../lib.mjs';

const UNBOXING = ['line1_take1', 'line2_take1', 'line3_take1', 'line3_take2', 'line4_take1', 'line5_take1'];
export const VIDEOS = {
  routine: { title: 'Morning routine', clips: [join(FIXTURES, 'routine', 'clip1.mp4')], broll: ['product.jpg', 'shelf.mp4', 'stopwatch.jpg'].map((f) => join(FIXTURES, 'routine', 'broll', f)) },
  unboxing: { title: 'Unboxing', clips: UNBOXING.map((n) => join(FIXTURES, 'unboxing', `${n}.mp4`)), broll: ['desk_before.jpg', 'organizer.mp4'].map((f) => join(FIXTURES, 'unboxing', 'broll', f)) },
  mistakes: { title: 'Three mistakes', clips: ['part1', 'part2'].map((n) => join(FIXTURES, 'mistakes', `${n}.mp4`)), broll: [] },
};

export async function choose(page, trigger, files) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 15_000 }), trigger()]);
  await chooser.setFiles(files);
}

async function mergeInto(page, titles, newTitle) {
  for (const t of titles) await page.getByRole('checkbox', { name: `Select ${t} to merge` }).click();
  await page.getByRole('button', { name: `Merge ${titles.length} into one video` }).click();
  // The merged video keeps the first one's place and name; rename it.
  const index = await page.getByRole('textbox', { name: /^Name of video \d+$/ }).evaluateAll((els, first) => els.findIndex((e) => e.value === first), titles[0]);
  assert(index >= 0, `merged video "${titles[0]}" not found`);
  const input = page.getByRole('textbox', { name: `Name of video ${index + 1}` });
  await input.fill(newTitle);
}

export default async function upload(ctx) {
  const { page, browser, errors } = await openApp(ctx, { userId: ctx.userId });
  try {
    // First launch: Home's empty state.
    await seeText(page, 'Your first video starts here');
    await shot(page, '01-home-empty');

    await page.getByRole('button', { name: 'Upload clips' }).first().click();
    await seeText(page, 'Pick clips from your library');

    const all = [...VIDEOS.routine.clips, ...VIDEOS.unboxing.clips, ...VIDEOS.mistakes.clips];
    await choose(page, () => page.getByRole('button', { name: 'Pick clips from your library' }).click(), all);
    await seeText(page, `${all.length} videos · ${all.length} clips`);

    // Group them: one video per fixture, clips in order.
    await page.getByRole('button', { name: /clip1, 1 clip\. Edit videos/ }).click();
    await seeText(page, 'Videos in this batch');
    await mergeInto(page, UNBOXING.map((n) => n.replace(/_/g, ' ')), VIDEOS.unboxing.title);
    await mergeInto(page, ['part1', 'part2'], VIDEOS.mistakes.title);
    await page.getByRole('textbox', { name: 'Name of video 1' }).fill(VIDEOS.routine.title);
    // Real durations from the picked files (seconds on web, not milliseconds).
    const editorText = await bodyText(page);
    assert(!/\b0:00\b/.test(editorText), 'a picked clip shows a duration of 0:00');

    // B-roll for the two fixtures that have it, from each video's card.
    const cards = page.locator('[aria-label^="Name of video"]');
    assert((await cards.count()) === 3, `expected 3 videos after merging, saw ${await cards.count()}`);
    const addBrollButtons = page.getByRole('button', { name: 'Add B-roll', exact: true });
    await choose(page, () => addBrollButtons.nth(0).click(), VIDEOS.routine.broll);
    await seeText(page, 'stopwatch.jpg');
    // The first card's button now reads "More B-roll", so the unboxing card's is the first "Add B-roll".
    await choose(page, () => addBrollButtons.nth(0).click(), VIDEOS.unboxing.broll);
    await seeText(page, 'organizer.mp4');
    await shot(page, '02-new-batch-editor');
    const order = await page.getByText(/^line\d_take\d\.mp4$/).allInnerTexts();
    assert(order.join(',') === UNBOXING.map((n) => `${n}.mp4`).join(','), `unboxing clips out of order: ${order}`);
    await page.getByRole('button', { name: 'Done' }).click();

    // Mode and hooks.
    await page.getByRole('radio', { name: 'TikTok Shop' }).click();
    for (let i = 0; i < 5; i++) {
      const now = Number(/\d+/.exec(await page.locator('[aria-label="variations"]').first().innerText({ timeout: 5000 }))?.[0]);
      if (now === 3) break;
      await page.getByRole('button', { name: now > 3 ? 'Fewer variations' : 'More variations' }).click();
    }
    await seeText(page, 'Each video ships with 3 openings');
    await seeText(page, '5 shots added');
    await shot(page, '03-new-batch');

    // Submit: the batch is created, the files go to the server's upload targets.
    const created = page.waitForResponse((r) => r.url().endsWith('/v1/batches') && r.request().method() === 'POST');
    const puts = [];
    page.on('request', (r) => {
      if (r.method() === 'PUT' && r.url().includes('/v1/local/upload/')) puts.push(r);
    });
    await page.getByRole('button', { name: 'Edit 3 videos' }).click();
    const res = await created;
    assert(res.status() === 201, `POST /batches answered ${res.status()}`);
    const batch = await res.json();
    const req = JSON.parse(res.request().postData());
    // Exact sizes and real content types for every picked file.
    const { statSync } = await import('node:fs');
    const expected = [VIDEOS.routine, VIDEOS.unboxing, VIDEOS.mistakes];
    req.videos.forEach((v, i) => {
      v.clips.forEach((c, k) => {
        assert(c.sizeBytes === statSync(expected[i].clips[k]).size, `${c.filename}: sizeBytes ${c.sizeBytes} is not the file's size`);
        assert(c.contentType === 'video/mp4', `${c.filename}: content type ${c.contentType}`);
      });
      v.broll.forEach((b, k) => assert(b.sizeBytes === statSync(expected[i].broll[k]).size, `${b.filename}: sizeBytes ${b.sizeBytes}`));
    });
    assert(req.videos.map((v) => v.title).join('|') === 'Morning routine|Unboxing|Three mistakes', `titles ${req.videos.map((v) => v.title)}`);
    assert(req.settings.mode === 'tiktok_shop' && req.settings.hookVariations === 3, 'mode or hooks not sent');
    ctx.state.batchId = batch.batch.id;
    ctx.state.videoIds = Object.fromEntries(batch.videos.map((v, i) => [['routine', 'unboxing', 'mistakes'][i], v.videoId]));
    ctx.log(`  batch ${batch.batch.id}: ${JSON.stringify(ctx.state.videoIds)}`);

    await page.waitForURL(/\/batch\//);
    // Watch the batch screen: upload progress, then analysis progress moving.
    const seen = new Set();
    const progress = { routine: [], unboxing: [], mistakes: [] };
    await waitFor(
      'all three videos to be ready to review',
      async () => {
        const text = await bodyText(page);
        for (const m of text.matchAll(/(Uploading \d+%|Uploaded\. Waiting to edit|Editing: finding the best takes · \d+%)/g)) seen.add(m[0]);
        const b = await ctx.api.batch(ctx.state.batchId);
        for (const v of b.videos) {
          const key = Object.entries(ctx.state.videoIds).find(([, id]) => id === v.id)?.[0];
          if (v.progress !== null) progress[key].push(v.progress);
          if (v.status === 'failed') throw new Error(`${v.title} failed: ${v.error}`);
        }
        if (seen.size === 1 || Math.random() < 0.05) await shot(page, '04-batch-progress');
        return b.videos.every((v) => v.status === 'ready_for_review');
      },
      { timeoutMs: 15 * 60_000, everyMs: 400 },
    ).catch(async (e) => {
      await shot(page, 'fail-batch');
      throw e;
    });
    assert(puts.length === 14, `expected 14 uploads (9 clips, 5 B-roll), saw ${puts.length}`);
    ctx.log(`  progress lines seen: ${[...seen].slice(0, 12).join(' | ')}${seen.size > 12 ? ' ...' : ''}`);
    for (const [k, list] of Object.entries(progress)) {
      const distinct = [...new Set(list.map((p) => Math.round(p * 100)))];
      ctx.log(`  ${k}: analysis progress ${distinct.join(',')}`);
      assert(distinct.length >= 2, `${k}: analysis progress never moved (${distinct})`);
      for (let i = 1; i < list.length; i++) assert(list[i] >= list[i - 1] - 1e-9, `${k}: progress went backwards`);
    }
    assert([...seen].some((s) => s.startsWith('Editing')), 'the batch screen never showed analysis progress');
    await seeText(page, '3 of 3 ready');
    await seeText(page, 'Review the first one');
    await shot(page, '05-batch-ready');

    // Home: the batch is done, so the three videos are in "Ready to review" with thumbnails.
    await page.getByRole('button', { name: /^Back$/ }).first().click().catch(() => page.goto(ctx.appUrl + '/'));
    await page.waitForURL((u) => new URL(u).pathname === '/');
    await seeText(page, 'Ready to review');
    for (const v of Object.values(VIDEOS)) await seeText(page, v.title);
    const thumbs = await page.locator('img').evaluateAll((imgs) => imgs.filter((i) => i.src.includes('/v1/local/file/') && i.naturalWidth > 0).length);
    assert(thumbs >= 3, `expected the three video thumbnails to load on Home, ${thumbs} did`);
    await shot(page, '06-home-ready');
    assert(!errors.length, `browser errors: ${errors.slice(0, 5).join(' | ')}`);
  } finally {
    await browser.close();
  }
}
