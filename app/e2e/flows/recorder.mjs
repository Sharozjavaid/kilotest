// Flow 5: write a three-line script, record and keep each line with Chromium's fake camera,
// redo one, finish with settings. The takes (WebM from MediaRecorder: no duration in the file,
// variable frame rate) upload, the server ingests and analyses them (no words: the fake
// microphone is a beep), the video lands in a sensible state that says so, and review opens.
import { assert, bodyText, openApp, seeText, shot, sleep, waitFor } from '../lib.mjs';

const SCRIPT = ['This is the first line of my script.', 'Here is the second line, said twice.', 'And this is how it ends.'];

async function recordTake(page, seconds) {
  await page.getByRole('button', { name: /^Record this line( again)?$/ }).click();
  await page.getByRole('button', { name: 'Stop recording' }).waitFor({ timeout: 15_000 });
  await sleep(seconds * 1000);
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await page.getByTestId('keep-next').and(page.locator(':not([aria-disabled="true"])')).waitFor({ timeout: 15_000 });
}

export default async function recorder(ctx) {
  const { page, browser, errors } = await openApp(ctx, { userId: ctx.userId, fakeMedia: true });
  try {
    await page.getByRole('button', { name: 'Record with script' }).click();
    await page.getByTestId('script-input').fill(SCRIPT.join('\n'));
    await page.getByTestId('split-script').click();
    await seeText(page, '3 lines');
    await shot(page, '19-record-script');
    await page.getByTestId('start-recording').click();
    await page.getByTestId('recorder').waitFor();
    // No countdown, to keep the run short.
    await page.getByTestId('text-size').click();
    await page.getByRole('radiogroup', { name: 'Countdown' }).getByRole('radio', { name: 'Off' }).click();
    await page.getByTestId('sheet-done').click();
    await page.getByTestId('capture-badge').and(page.locator('[aria-label^="Recording at"]')).waitFor({ timeout: 20_000 });

    // Line 1, keep. Line 2, record, redo, keep take 2. Line 3, keep.
    await recordTake(page, 2.5);
    await shot(page, '20-record-take');
    await page.getByTestId('keep-next').click();
    await seeText(page, SCRIPT[1]);
    await recordTake(page, 2);
    await recordTake(page, 2.5); // "Record this line again": the redo replaces take 1
    await page.getByTestId('keep-next').click();
    await seeText(page, SCRIPT[2]);
    await recordTake(page, 2);
    await page.getByTestId('keep-next').click();
    await page.getByTestId('finish').click();

    // Finish: the takes, a name and settings.
    await page.waitForURL(/\/record\/finish/);
    await seeText(page, 'Take 2');
    await page.getByTestId('video-title').fill('Recorded with the fake camera');
    await page.getByRole('radio', { name: 'General' }).click();
    await shot(page, '21-record-finish');
    const created = page.waitForResponse((r) => r.url().endsWith('/v1/batches') && r.request().method() === 'POST');
    await page.getByTestId('submit-recording').click();
    const res = await created;
    assert(res.status() === 201, `POST /batches answered ${res.status()}: ${await res.text()}`);
    const req = JSON.parse(res.request().postData());
    const body = await res.json();
    const v = req.videos[0];
    ctx.log(`  clips: ${v.clips.map((c) => `${c.filename} ${c.contentType} ${c.sizeBytes}B line ${c.scriptLineIndex} take ${c.takeNumber}`).join('; ')}`);
    assert(v.source === 'recorder' && v.clips.length === 3, 'the recording was not sent as three recorder clips');
    assert(JSON.stringify(v.clips.map((c) => [c.scriptLineIndex, c.takeNumber])) === JSON.stringify([[0, 1], [1, 2], [2, 1]]), 'script lines and take numbers are wrong');
    assert(JSON.stringify(v.script) === JSON.stringify(SCRIPT), 'the script was not sent');
    const videoId = body.videos[0].videoId;
    ctx.state.recordedVideoId = videoId;

    // Upload, ingest, analysis.
    await page.waitForURL(/\/batch\//);
    const statuses = [];
    await waitFor('the recorded video to finish analysis', async () => {
      const d = await ctx.api.video(videoId);
      if (statuses.at(-1) !== d.status) statuses.push(d.status);
      return d.status === 'ready_for_review' || d.status === 'failed';
    }, { timeoutMs: 6 * 60_000, everyMs: 700 });
    const d = await ctx.api.video(videoId);
    ctx.log(`  status: ${statuses.join(' -> ')}${d.error ? ` (${d.error})` : ''}`);
    assert(d.status === 'ready_for_review', `the recorded video ended ${d.status}: ${d.error}`);
    ctx.log(`  clips: ${d.clips.map((c) => `${c.durationSec.toFixed(2)}s @ ${c.fps}fps`).join(', ')}; kept ${d.keptSec}s of ${d.totalSec}s; words ${d.transcripts.reduce((n, t) => n + t.words.length, 0)}`);
    assert(d.clips.length === 3 && d.clips.every((c) => c.durationSec > 1 && c.durationSec < 6), 'clip durations were not measured from the WebM takes');
    assert(d.keptSec > 3, `the edit is (nearly) empty: ${d.keptSec}s kept`);

    // Review opens and tells the creator what happened.
    await seeText(page, 'Review the first one', 30_000);
    await page.getByRole('button', { name: 'Review the first one' }).click();
    await page.waitForURL(/\/review\//);
    await seeText(page, 'Final length');
    const text = await bodyText(page);
    assert(/no speech|couldn't hear|could not hear|any speech/i.test(text), 'the review screen does not say that no speech was found');
    await shot(page, '22-record-review');
    // The takes were deleted once their uploads were confirmed (on web: the blob URLs are revoked).
    const errorsBefore = errors.length;
    const takes = await page.evaluate(async () => {
      const jobs = JSON.parse(localStorage.getItem('kilo.uploads.v1') ?? '[]').filter((j) => j.deleteAfterUpload);
      const out = [];
      for (const j of jobs) {
        let alive = true;
        try {
          await fetch(j.fileUri);
        } catch {
          alive = false;
        }
        out.push({ status: j.status, alive });
      }
      return out;
    });
    errors.splice(errorsBefore); // our own fetches of the revoked URLs
    ctx.log(`  takes after upload: ${JSON.stringify(takes)}`);
    assert(takes.length === 3 && takes.every((t) => t.status === 'done' && !t.alive), 'recorded takes were not deleted after their upload');
    assert(!errors.length, `browser errors: ${errors.slice(0, 5).join(' | ')}`);
  } finally {
    await browser.close();
  }
}
