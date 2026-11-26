// Flow 7: failure paths. A file that is not a video (the picker refuses a text file outright;
// one named .mp4 uploads and the video fails with a message the creator can act on, and retry
// behaves). The server stops mid-upload and comes back: the upload queue recovers. A video id
// that does not exist.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, WORK, assert, bodyText, openApp, seeText, shot, sleep, waitFor } from '../lib.mjs';
import { choose } from './upload.mjs';

async function newBatch(ctx, page, files, title) {
  await page.goto(ctx.appUrl + '/new-batch', { waitUntil: 'networkidle' });
  await choose(page, () => page.getByRole('button', { name: 'Pick clips from your library' }).click(), files);
  await page.getByRole('button', { name: /1 clip\. Edit videos/ }).first().click();
  await page.getByRole('textbox', { name: 'Name of video 1' }).fill(title);
  await page.getByRole('button', { name: 'Done' }).click();
  const created = page.waitForResponse((r) => r.url().endsWith('/v1/batches') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Edit 1 video' }).click();
  const res = await created;
  assert(res.status() === 201, `POST /batches answered ${res.status()}`);
  const body = await res.json();
  await page.waitForURL(/\/batch\//);
  return body.videos[0].videoId;
}

export default async function failures(ctx) {
  const dir = join(WORK, 'bad');
  mkdirSync(dir, { recursive: true });
  const text = join(dir, 'notes.txt');
  const fake = join(dir, 'not-a-video.mp4');
  writeFileSync(text, 'just some notes\n');
  writeFileSync(fake, 'This is text with a video name.\n'.repeat(2000));
  const { page, browser, errors } = await openApp(ctx, { userId: ctx.userId });
  try {
    // 1. A text file: the picker says what is wrong.
    await page.goto(ctx.appUrl + '/new-batch', { waitUntil: 'networkidle' });
    ctx.dialogs.length = 0;
    await choose(page, () => page.getByRole('button', { name: 'Pick clips from your library' }).click(), [text]);
    await waitFor('the picker to refuse the text file', () => ctx.dialogs.length > 0, { timeoutMs: 10_000 });
    assert(/only use videos/.test(ctx.dialogs.at(-1)), `unhelpful message for a text file: ${ctx.dialogs.at(-1)}`);

    // 2. Text named .mp4: it uploads, the video fails with a message the creator can act on.
    const badId = await newBatch(ctx, page, [fake], 'Not really a video');
    await waitFor('the bad video to fail', async () => (await ctx.api.video(badId)).status === 'failed', { timeoutMs: 120_000, everyMs: 700 });
    const failed = await ctx.api.video(badId);
    ctx.log(`  failed with: ${failed.error}`);
    // The pipeline refuses it by content; its own words reach the creator, naming the file.
    assert(/not supported|could not be read/i.test(failed.error) && failed.error.includes('not-a-video.mp4'), `unhelpful error: ${failed.error}`);
    await seeText(page, failed.error, 20_000);
    await shot(page, '27-failed-video');
    // Retry: back through analysis, and failed again with the same message (the file is still not a video).
    const statuses = new Set();
    await page.getByRole('button', { name: 'Try editing Not really a video again' }).click();
    await waitFor('the retried video to settle', async () => {
      const v = await ctx.api.video(badId);
      statuses.add(v.status);
      return v.status === 'failed' && statuses.size > 1;
    }, { timeoutMs: 120_000, everyMs: 300 });
    ctx.log(`  retry: ${[...statuses].join(' -> ')}`);
    await seeText(page, failed.error, 20_000);
    // The creator can delete it from Home's batch card? At least the failure shows on Home.
    await page.goto(ctx.appUrl + '/', { waitUntil: 'networkidle' });

    // 3. The server stops mid-upload and comes back: the queue retries and the video goes on.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: -1, uploadThroughput: 40_000 });
    const clip = join(FIXTURES, 'mistakes', 'part1.mp4');
    const vid = await newBatch(ctx, page, [clip], 'Survives a restart');
    await seeText(page, /Uploading ([1-9]|[1-6]\d)%/, 20_000);
    ctx.log('  stopping the server mid-upload');
    await ctx.server.stop();
    await sleep(2500);
    const during = await bodyText(page);
    await shot(page, '28-upload-server-down');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await ctx.server.start();
    ctx.log('  server back');
    await waitFor('the interrupted video to be analysed', async () => {
      const v = await ctx.api.video(vid);
      if (v.status === 'failed') throw new Error(`failed: ${v.error}`);
      return v.status === 'ready_for_review';
    }, { timeoutMs: 4 * 60_000, everyMs: 1000 }).catch(async (e) => {
      await shot(page, 'fail-restart');
      ctx.log(`  page said: ${(await bodyText(page)).slice(0, 400)}`);
      throw e;
    });
    assert(/Uploading/.test(during), `the batch screen did not show the interrupted upload: ${during.slice(0, 200)}`);
    await seeText(page, /kept of/, 30_000);
    await shot(page, '29-upload-recovered');

    // 4. A video that does not exist, and a malformed id.
    for (const path of [`/review/${randomUUID()}`, '/review/not-an-id', `/export/${randomUUID()}`, `/broll/${randomUUID()}`]) {
      await page.goto(ctx.appUrl + path, { waitUntil: 'networkidle' });
      await page.getByTestId('not-found').waitFor({ timeout: 15_000 });
      if (path === '/review/not-an-id') await shot(page, '30-not-found');
    }
    await page.getByRole('button', { name: 'Go to Home' }).click();
    await page.waitForURL((u) => new URL(u).pathname === '/');
    assert(!errors.filter((e) => !/Failed to load resource/.test(e)).length, `browser errors: ${errors.slice(0, 5).join(' | ')}`);
  } finally {
    await browser.close();
  }
}
