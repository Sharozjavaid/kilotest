// The 30-video run (opt-in: `npm run e2e:batch30`, or E2E_ONLY=batch30). The phase 1 test from
// PLAN.md as far as a browser can take it: "A creator uploads 30 videos, fixes mistakes by
// tapping, and saves all of them without help."
//
// As a fresh creator, through the app's UI only (the API is read to know what the screens should
// show and to score the edit, never to change anything):
//   1. picks the 72 clips of fixtures/out/batch30 (two picks: the library picker takes 60 at a
//      time), merges the multi-clip recordings in the batch editor, names them, adds B-roll, sets
//      the batch (mode, three hooks) and starts ONE batch of 30;
//   2. watches the Batch and Home screens until all 30 are ready to review: upload and analysis
//      progress, no video failed or stuck;
//   3. reviews every video: the transcript rows against the EDL, the automatic edit against the
//      fixture's ground truth; fixes each wrong unit by tapping its row; on 10 videos makes a
//      deliberate edit (cuts a kept line or restores a cut one); burns in captions on 5;
//      "Looks good", which starts the final renders, then "Next video";
//   4. waits for every final render, then downloads every version from each Export screen
//      ("Download all 3"), reached from Home's Finished list;
//   5. checks every file: 1080x1920, the EDL's frame rate, duration within two frames of the
//      saved edit, about -14 LUFS, and every frame traced back to the fixture unit it shows (no
//      cut line, the band colours agree; deliberately restored lines are there, deliberately cut
//      ones are not);
//   6. ends on Home: all 30 finished; marking one as posted moves the weekly goal.
// Measurements and every finding go to .work/e2e/batch30/report.json and the log.
//
// Options (environment): E2E_BATCH30_COUNT=n uses only the first n recordings (to develop the
// flow; the phase 1 claim needs all 30). E2E_BATCH30_MODE=general|ugc_ad|tiktok_shop (default
// general; mode and hooks are per batch, see the report).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PACING_PARAMS, resolveTimeline } from '@kilo/edl';
import { FIXTURES, WORK, Failure, apiClient, assert, bodyText, openApp, seeText, shot, sleep, waitFor } from '../lib.mjs';
import { bandShares, covered, loudness, overlapLen, probeFile } from '../media.mjs';
import { expectedRows } from './review.mjs';
import { choose } from './upload.mjs';

const execFileP = promisify(execFile);
const SRC = join(FIXTURES, 'batch30');
const OUT = join(WORK, 'batch30');
const COUNT = Math.max(1, Math.min(30, Number(process.env.E2E_BATCH30_COUNT ?? 30)));
const MODE = process.env.E2E_BATCH30_MODE ?? 'general';
const MODE_LABEL = { general: 'General', ugc_ad: 'UGC ad', tiktok_shop: 'TikTok Shop' }[MODE];
/** The device picker takes this many files at a time (src/newBatch/picker.ts). */
const PICK_LIMIT = 60;
/** Videos (by index in the batch) that get a deliberate edit, and those that get captions. */
const DELIBERATE = new Set([1, 4, 7, 10, 13, 16, 19, 22, 25, 28]);
const CAPTIONS = new Map([[0, 'Clean'], [6, 'Bold'], [12, 'Karaoke'], [18, 'Clean'], [24, 'Bold']]);

const sec = (ms) => Math.round(ms / 100) / 10;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};
const spread = (xs) => (xs.length ? { min: Math.min(...xs), median: median(xs), max: Math.max(...xs), n: xs.length } : null);

function loadRecordings() {
  assert(existsSync(SRC), `no recordings in ${SRC}: run node fixtures/make-batch30.mjs --generate`);
  const ids = readdirSync(SRC).filter((d) => existsSync(join(SRC, d, 'manifest.json'))).sort();
  assert(ids.length >= COUNT, `expected at least ${COUNT} recordings in ${SRC}, found ${ids.length}: run node fixtures/make-batch30.mjs --generate`);
  return ids.slice(0, COUNT).map((id) => {
    const dir = join(SRC, id);
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    for (const c of m.clips) c.words = JSON.parse(readFileSync(join(dir, c.wordsFile), 'utf8')).words;
    return {
      id,
      title: m.title,
      manifest: m,
      clips: m.clips.map((c) => join(dir, c.file)),
      clipNames: m.clips.map((c) => c.file),
      broll: m.broll.map((b) => join(dir, b.file)),
      sourceSec: m.clips.reduce((n, c) => n + c.durationSec, 0),
    };
  });
}

// ---- Scoring the edit against the ground truth -------------------------------------------------

/** Every ground-truth unit (pauses left out, as in the acceptance run) the EDL gets wrong. */
function score(edl, rec, clipIds) {
  const problems = [];
  rec.manifest.clips.forEach((mc, j) => {
    const clipId = clipIds[j];
    const segs = edl.segments.filter((s) => s.clipId === clipId);
    const kept = segs.filter((s) => s.keep).map((s) => [s.start, s.end]);
    for (const u of mc.units) {
      if (u.kind === 'pause') continue;
      if (u.keep) {
        const words = mc.words.filter((w) => w.start >= u.start - 1e-3 && w.end <= u.end + 1e-3);
        const lost = words.filter((w) => !covered(kept, w.start, w.end));
        if (lost.length) problems.push({ kind: lost.length === words.length ? 'kept_line_cut' : 'kept_line_clipped', reason: 'speech', clip: j, unit: u, words: lost });
      } else {
        const share = overlapLen(kept, u.start, u.end) / (u.end - u.start);
        if (share >= 0.1) problems.push({ kind: 'cut_line_kept', reason: u.reason, clip: j, unit: u, share });
      }
    }
  });
  return problems;
}

/** A segment has a transcript row (src/review/rows.ts) when it has words or is a second or more of silence. */
const hasRow = (s) => s.text.trim().length > 0 || s.end - s.start >= 1;

/**
 * The taps that fix the problems, as a creator would make them: the cut rows a kept line's lost
 * words are in, the kept rows a cut line is in. A tap that would also bring back cut content or
 * drop kept words (a row holding both) cannot fix it; those are returned as unfixable.
 */
function planFixes(edl, rec, clipIds, problems) {
  const taps = new Set();
  const unfixable = [];
  for (const p of problems) {
    const mc = rec.manifest.clips[p.clip];
    const clipId = clipIds[p.clip];
    const segs = edl.segments.filter((s) => s.clipId === clipId);
    const keptWords = (s) => mc.units.filter((u) => u.keep && u.kind !== 'pause').flatMap((u) => mc.words.filter((w) => w.start >= u.start - 1e-3 && w.end <= u.end + 1e-3)).filter((w) => w.end > s.start + 1e-3 && w.start < s.end - 1e-3);
    const cutUnits = (s) => mc.units.filter((u) => !u.keep && u.kind !== 'pause' && overlapLen([[s.start, s.end]], u.start, u.end) / (u.end - u.start) >= 0.1);
    let candidates;
    if (p.kind === 'cut_line_kept') candidates = segs.filter((s) => s.keep && overlapLen([[s.start, s.end]], p.unit.start, p.unit.end) > 0.02);
    else candidates = segs.filter((s) => !s.keep && p.words.some((w) => w.end > s.start + 1e-3 && w.start < s.end - 1e-3));
    const bad = candidates.find((s) => !hasRow(s) || (p.kind === 'cut_line_kept' ? keptWords(s).length > 0 : cutUnits(s).length > 0));
    if (!candidates.length || bad) unfixable.push({ ...p, why: !candidates.length ? 'no segment to tap' : !hasRow(bad) ? 'the segment has no row' : 'one row holds both kept and cut speech' });
    else for (const s of candidates) taps.add(s.id);
  }
  return { taps: [...taps], unfixable };
}

const describe = (p) => `${p.kind}${p.reason !== 'speech' ? ` (${p.reason})` : ''} "${p.unit.text}"${p.words ? ` lost: ${p.words.map((w) => w.text).join(' ')}` : ''}${p.share !== undefined ? ` ${Math.round(p.share * 100)}% kept` : ''}`;

// ---- Measuring ---------------------------------------------------------------------------------

async function duBytes(dir) {
  if (!existsSync(dir)) return 0;
  try {
    const { stdout } = await execFileP('du', ['-sb', dir]);
    return Number(stdout.split('\t')[0]);
  } catch {
    return 0; // a file vanished while du walked the tree
  }
}

async function psql(databaseUrl, sql) {
  const { stdout } = await execFileP('psql', [databaseUrl, '-At', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-c', sql], { maxBuffer: 1 << 24 });
  return stdout.trim() ? stdout.trim().split('\n').map((l) => l.split('\t')) : [];
}

/** Per-job wall time from pg-boss's own records (started_on .. completed_on), live and archived. */
async function jobTimes(databaseUrl, name) {
  const tables = (await psql(databaseUrl, `select table_name from information_schema.tables where table_schema = 'pgboss' and table_name in ('job', 'archive')`)).map((r) => r[0]);
  const rows = [];
  for (const t of tables) {
    rows.push(
      ...(await psql(
        databaseUrl,
        `select data::text, state, extract(epoch from started_on), extract(epoch from completed_on), retry_count from pgboss.${t} where name = '${name}' and started_on is not null`,
      )),
    );
  }
  return rows.map(([data, state, s, c, retries]) => ({ data: JSON.parse(data), state, sec: c ? Number(c) - Number(s) : null, retries: Number(retries) }));
}

async function browserMetrics(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  return { jsHeapMB: Math.round((m.JSHeapUsedSize ?? 0) / 1e5) / 10, nodes: m.Nodes, listeners: m.JSEventListeners, documents: m.Documents };
}

/** Long tasks (main thread blocked over 50 ms) since the last call. */
async function takeLongTasks(page) {
  return page.evaluate(() => {
    const w = window;
    if (!w.__kiloLong) {
      w.__kiloLong = [];
      try {
        new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__kiloLong.push(Math.round(e.duration)))).observe({ type: 'longtask', buffered: false });
      } catch {}
    }
    const out = w.__kiloLong.splice(0);
    return out;
  });
}

// ---- The flow ----------------------------------------------------------------------------------

export default async function batch30(ctx) {
  const recs = loadRecordings();
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, 'downloads'), { recursive: true });
  // A creator of its own, so this flow does not depend on (or disturb) the default flows.
  const userId = randomUUID();
  const api = apiClient(ctx.apiUrl, userId);
  const T0 = Date.now();
  const report = {
    videos: recs.length,
    clips: recs.reduce((n, r) => n + r.clips.length, 0),
    broll: recs.reduce((n, r) => n + r.broll.length, 0),
    sourceSec: Math.round(recs.reduce((n, r) => n + r.sourceSec, 0)),
    mode: MODE,
    timings: {},
    perVideo: {},
    mistakes: [],
    unfixable: [],
    deliberate: [],
    captions: [],
    exportRequests: [],
    findings: [],
    checks: [],
    disk: { peakStorageMB: 0, peakJobsMB: 0, peakTotalMB: 0, samples: [] },
    browser: [],
    requests: {},
    longTasks: [],
  };
  const finding = (kind, text) => {
    report.findings.push({ kind, text, atSec: sec(Date.now() - T0) });
    ctx.log(`  FINDING (${kind}): ${text}`);
  };
  const save = () => writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  const mark = (name) => {
    report.timings[name] = sec(Date.now() - T0);
    ctx.log(`  [${report.timings[name]}s] ${name}`);
  };
  ctx.log(`  ${recs.length} recordings, ${report.clips} clips, ${report.broll} B-roll files, ${report.sourceSec}s of footage; user ${userId}`);

  // Disk: storage and the worker's job folders, sampled through the whole run.
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const [s, j] = await Promise.all([duBytes(ctx.server.storageDir), duBytes(ctx.server.workDir)]);
      const mb = (b) => Math.round(b / 1e5) / 10;
      report.disk.peakStorageMB = Math.max(report.disk.peakStorageMB, mb(s));
      report.disk.peakJobsMB = Math.max(report.disk.peakJobsMB, mb(j));
      report.disk.peakTotalMB = Math.max(report.disk.peakTotalMB, mb(s + j));
      report.disk.samples.push([sec(Date.now() - T0), mb(s), mb(j)]);
      await sleep(10_000);
    }
  })();

  const { page, browser, errors } = await openApp(ctx, { userId });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const snapshot = async (stage) => {
    const m = { stage, atSec: sec(Date.now() - T0), ...(await browserMetrics(cdp)) };
    report.browser.push(m);
    ctx.log(`  browser at ${stage}: heap ${m.jsHeapMB} MB, ${m.nodes} DOM nodes, ${m.listeners} listeners`);
  };
  // Every API request the page makes, by route and phase: the polling load at 30 videos.
  let phase = 'create';
  const route = (u) => {
    const p = new URL(u).pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id').replace(/\/local\/(upload|file)\/[^/]+/, '/local/$1/:token');
    return p;
  };
  const inflight = { puts: 0, maxPuts: 0 };
  page.on('request', (r) => {
    if (!r.url().startsWith(ctx.apiUrl)) return;
    const key = `${r.method()} ${route(r.url())}`;
    const bucket = (report.requests[phase] ??= { startSec: sec(Date.now() - T0), counts: {} });
    bucket.counts[key] = (bucket.counts[key] ?? 0) + 1;
    if (r.method() === 'PUT' && r.url().includes('/v1/local/upload/')) inflight.maxPuts = Math.max(inflight.maxPuts, ++inflight.puts);
  });
  const putDone = (r) => {
    if (r.method() === 'PUT' && r.url().includes('/v1/local/upload/')) inflight.puts--;
  };
  page.on('requestfinished', putDone);
  page.on('requestfailed', putDone);
  const failedResponses = [];
  page.on('response', (r) => {
    if (r.url().startsWith(ctx.apiUrl) && r.status() >= 400 && r.status() !== 409) failedResponses.push(`${r.status()} ${r.request().method()} ${route(r.url())}`);
  });
  await takeLongTasks(page);
  const longTasks = async (stage) => {
    const t = await takeLongTasks(page);
    report.longTasks.push({ stage, count: t.length, totalMs: t.reduce((a, b) => a + b, 0), maxMs: t.length ? Math.max(...t) : 0 });
  };

  try {
    // ==== 1. One batch of 30, built in the New batch screen ===================================
    await seeText(page, 'Your first video starts here');
    await page.getByRole('button', { name: 'Upload clips' }).first().click();
    await seeText(page, 'Pick clips from your library');
    const allClips = recs.flatMap((r) => r.clips);
    const firstPick = allClips.slice(0, PICK_LIMIT);
    const tPick = Date.now();
    await choose(page, () => page.getByRole('button', { name: 'Pick clips from your library' }).click(), firstPick);
    await seeText(page, `${firstPick.length} videos · ${firstPick.length} clips`);
    // Open the editor from the strip, then pick the rest from inside it ("Add more clips").
    await page.getByRole('button', { name: /\. Edit videos$/ }).first().click();
    await seeText(page, 'Videos in this batch');
    if (allClips.length > PICK_LIMIT) {
      await choose(page, () => page.getByRole('button', { name: 'Add more clips' }).click(), allClips.slice(PICK_LIMIT));
      await seeText(page, `${allClips.length} videos`);
    }
    const names = page.getByRole('textbox', { name: /^Name of video \d+$/ });
    assert((await names.count()) === allClips.length, `the editor shows ${await names.count()} videos for ${allClips.length} picked clips`);
    report.timings.pickSec = sec(Date.now() - tPick);
    await shot(page, 'b30-01-editor-72');
    await longTasks('pick');

    // Merge each multi-clip recording, in order; a merged video keeps its first clip's place.
    const tMerge = Date.now();
    for (const r of recs) {
      const titles = r.clipNames.map((f) => f.replace(/\.mp4$/, '').replace(/_/g, ' '));
      if (titles.length > 1) {
        for (const t of titles) await page.getByRole('checkbox', { name: `Select ${t} to merge` }).click();
        await page.getByRole('button', { name: `Merge ${titles.length} into one video` }).click();
      }
      const index = await names.evaluateAll((els, first) => els.findIndex((e) => e.value === first), titles[0]);
      assert(index >= 0, `video "${titles[0]}" not found after merging`);
      await page.getByRole('textbox', { name: `Name of video ${index + 1}`, exact: true }).fill(r.title);
    }
    assert((await names.count()) === recs.length, `expected ${recs.length} videos after merging, saw ${await names.count()}`);
    const titlesNow = await names.evaluateAll((els) => els.map((e) => e.value));
    assert(titlesNow.join('|') === recs.map((r) => r.title).join('|'), `videos out of order after merging: ${titlesNow.join(', ')}`);
    // Clip order inside every merged video, as the editor lists it.
    const listed = await page.getByText(/^b\d\d_take\d\.mp4$/).allInnerTexts();
    assert(listed.join(',') === recs.flatMap((r) => r.clipNames).join(','), 'clips are out of order in the editor');
    report.timings.mergeSec = sec(Date.now() - tMerge);
    await longTasks('merge');

    // B-roll from each video's own card (one "Add B-roll" or "More B-roll" button per card).
    const brollButtons = page.getByRole('button', { name: /^(Add|More) B-roll$/ });
    for (const [i, r] of recs.entries()) {
      if (!r.broll.length) continue;
      await choose(page, () => brollButtons.nth(i).click(), r.broll);
      await seeText(page, r.manifest.broll.at(-1).file.replace(/^broll\//, ''));
    }
    await shot(page, 'b30-02-editor-merged');
    await page.getByRole('button', { name: 'Done' }).click();

    // The batch: mode, three hooks, captions off (they go on per video in Review).
    if (MODE !== 'general') await page.getByRole('radio', { name: MODE_LABEL }).click();
    for (let k = 0; k < 6; k++) {
      const now = Number(/\d+/.exec(await page.locator('[aria-label="variations"]').first().innerText({ timeout: 5000 }))?.[0]);
      if (now === 3) break;
      await page.getByRole('button', { name: now > 3 ? 'Fewer variations' : 'More variations' }).click();
    }
    await seeText(page, 'Each video ships with 3 openings');
    const capOn = await page.getByRole('switch', { name: 'Burn in captions' }).getAttribute('aria-checked').catch(() => null);
    if (capOn === 'true') await page.getByRole('switch', { name: 'Burn in captions' }).click();
    await seeText(page, `${recs.length} videos · ${report.clips} clips`);
    await shot(page, 'b30-03-new-batch');

    // Upload over a phone-like uplink (about 1.5 MB/s), so the queue's behaviour shows.
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: -1, uploadThroughput: 1_500_000 });
    const created = page.waitForResponse((r) => r.url().endsWith('/v1/batches') && r.request().method() === 'POST', { timeout: 60_000 });
    const tSubmit = Date.now();
    await page.getByRole('button', { name: `Edit ${recs.length} videos` }).click();
    const res = await created;
    assert(res.status() === 201, `POST /batches answered ${res.status()}: ${await res.text()}`);
    const batch = await res.json();
    const req = JSON.parse(res.request().postData());
    assert(req.videos.length === recs.length, `the batch was created with ${req.videos.length} videos`);
    req.videos.forEach((v, i) => {
      const r = recs[i];
      assert(v.title === r.title, `video ${i + 1} is "${v.title}", expected "${r.title}"`);
      assert(v.clips.length === r.clips.length && v.broll.length === r.broll.length, `${r.title}: ${v.clips.length} clips and ${v.broll.length} B-roll sent`);
      v.clips.forEach((c, k) => assert(c.sizeBytes === statSync(r.clips[k]).size, `${c.filename}: sizeBytes ${c.sizeBytes}`));
    });
    assert(req.settings.mode === MODE && req.settings.hookVariations === 3 && !req.settings.captions, `settings sent: ${JSON.stringify(req.settings)}`);
    const batchId = batch.batch.id;
    const ids = batch.videos.map((v) => v.videoId);
    const recOf = new Map(ids.map((id, i) => [id, { ...recs[i], index: i }]));
    for (const [id, r] of recOf) report.perVideo[r.id] = { title: r.title, videoId: id, clips: r.clips.length, broll: r.broll.length, sourceSec: Math.round(r.sourceSec * 10) / 10 };
    mark('batch created');
    phase = 'upload+analysis';

    // ==== 2. Until all 30 are ready to review ================================================
    await page.waitForURL(/\/batch\//);
    const seenLines = new Set();
    const progress = new Map(ids.map((id) => [id, []]));
    const readyAt = new Map();
    const uploadedAt = new Map();
    let lastChange = Date.now();
    let lastSig = '';
    let uploadsDone = false;
    let homeChecked = false;
    let headerOk = 0;
    await waitFor(
      `all ${recs.length} videos to be ready to review`,
      async () => {
        const b = await api.batch(batchId);
        const text = await bodyText(page).catch(() => '');
        for (const m of text.matchAll(/(Uploading \d+% · \d+ of \d+ files? in|Waiting to upload from this phone|Upload stopped|Uploaded\. Waiting to edit|Editing: finding the best takes · \d+%)/g)) seenLines.add(m[0].replace(/\d+/g, 'n'));
        for (const v of b.videos) {
          if (v.status === 'failed') throw new Failure(`${v.title} failed: ${v.error}`);
          if (v.progress !== null) progress.get(v.id).push(v.progress);
          if (v.status !== 'uploading' && !uploadedAt.has(v.id)) uploadedAt.set(v.id, Date.now());
          if (v.status === 'ready_for_review' && !readyAt.has(v.id)) readyAt.set(v.id, Date.now());
        }
        // The header agrees with the server (allowing one poll of lag).
        const header = /(\d+) of (\d+) ready/.exec(text);
        if (header) {
          assert(Number(header[2]) === recs.length, `the batch header says "${header[0]}"`);
          if (Math.abs(Number(header[1]) - readyAt.size) <= 2) headerOk++;
        }
        const sig = b.videos.map((v) => `${v.status}:${v.progress}`).join(',');
        if (sig !== lastSig) {
          lastSig = sig;
          lastChange = Date.now();
        }
        // Stuck: nothing at all moved for ten minutes (the queue runs one video at a time, so
        // waiting videos are not stuck while another one moves).
        if (Date.now() - lastChange > 10 * 60_000) throw new Failure(`no video moved for 10 minutes: ${b.videos.map((v) => `${v.title}=${v.status}`).join(', ')}`);
        if (!uploadsDone && b.videos.every((v) => v.status !== 'uploading')) {
          uploadsDone = true;
          mark('all uploaded');
          report.timings.uploadSec = sec(Date.now() - tSubmit);
          await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
          await shot(page, 'b30-04-batch-editing');
        }
        if (!report.shotUploading && text.includes('Uploading')) {
          report.shotUploading = true;
          await shot(page, 'b30-04-batch-uploading');
        }
        // Midway: Home shows the batch with a done count that matches.
        if (!homeChecked && readyAt.size >= Math.ceil(recs.length / 3) && readyAt.size < recs.length) {
          homeChecked = true;
          await page.getByRole('button', { name: /^Back$/ }).first().click();
          await page.waitForURL((u) => new URL(u).pathname === '/');
          const card = page.getByRole('button', { name: new RegExp(`^Batch of ${recs.length} is (editing|uploading), \\d+ done`) });
          await card.waitFor({ timeout: 20_000 });
          const label = await card.getAttribute('aria-label');
          const done = Number(/(\d+) done/.exec(label)[1]);
          const server = (await api.batch(batchId)).videos.filter((v) => ['ready_for_review', 'rendering', 'done'].includes(v.status)).length;
          ctx.log(`  Home midway: "${label}" (server: ${server} ready)`);
          assert(Math.abs(done - server) <= 2, `Home says ${done} done, the server ${server}`);
          const listed = await page.getByRole('button', { name: new RegExp(`^(${recs.map((r) => r.title).join('|')}), `) }).count();
          ctx.log(`  Home midway lists ${listed} ready videos`);
          await shot(page, 'b30-05-home-midway');
          await card.click();
          await page.waitForURL(/\/batch\//);
        }
        return b.videos.every((v) => v.status === 'ready_for_review');
      },
      { timeoutMs: 120 * 60_000, everyMs: 2000 },
    ).catch(async (e) => {
      await shot(page, 'b30-fail-batch');
      throw e;
    });
    mark('all ready');
    report.timings.toAllReadySec = sec(Date.now() - tSubmit);
    report.upload = { puts: Object.entries(report.requests['upload+analysis']?.counts ?? {}).filter(([k]) => k.startsWith('PUT /v1/local/upload')).reduce((n, [, c]) => n + c, 0), maxConcurrentPuts: inflight.maxPuts, lines: [...seenLines] };
    ctx.log(`  uploads: ${report.upload.puts} PUTs for ${report.clips + report.broll} files, at most ${inflight.maxPuts} at once; lines seen: ${[...seenLines].join(' | ')}`);
    assert(report.upload.puts >= report.clips + report.broll, `only ${report.upload.puts} uploads for ${report.clips + report.broll} files`);
    for (const [id, list] of progress) {
      for (let i = 1; i < list.length; i++) assert(list[i] >= list[i - 1] - 1e-9, `${recOf.get(id).title}: analysis progress went backwards (${list[i - 1]} -> ${list[i]})`);
      report.perVideo[recOf.get(id).id].readyAfterSubmitSec = sec(readyAt.get(id) - tSubmit);
    }
    assert(headerOk > 0, 'the batch header never matched the server count');
    await seeText(page, `${recs.length} of ${recs.length} ready`);
    await seeText(page, 'Review the first one');
    await shot(page, 'b30-06-batch-ready');
    await snapshot('all ready (Batch screen)');
    await longTasks('upload+analysis');

    // Home: every video in "Ready to review".
    phase = 'home';
    const tHome = Date.now();
    await page.getByRole('button', { name: /^Back$/ }).first().click();
    await page.waitForURL((u) => new URL(u).pathname === '/');
    await seeText(page, 'Ready to review');
    const readyRows = page.getByRole('button', { name: new RegExp(`^(${recs.map((r) => r.title).join('|')}), `) });
    await waitFor('Home to list every video', async () => (await readyRows.count()) === recs.length, { timeoutMs: 30_000 });
    report.timings.homeListMs = Date.now() - tHome;
    const loadedThumbs = await page.locator('img').evaluateAll((imgs) => imgs.filter((i) => i.src.includes('/v1/local/file/') && i.naturalWidth > 0).length);
    ctx.log(`  Home lists ${recs.length} ready videos in ${report.timings.homeListMs} ms; ${loadedThumbs} thumbnails loaded`);
    // Scroll the whole list like a thumb would, and count blocked frames.
    await takeLongTasks(page);
    for (let k = 0; k < 25; k++) {
      await page.mouse.wheel(0, 400);
      await sleep(60);
    }
    await longTasks('home scroll (30 rows)');
    await shot(page, 'b30-07-home-ready');
    await snapshot('Home with 30 ready');
    const homeBody = await api.home();
    assert(homeBody.readyToReview.length === recs.length, `GET /home lists ${homeBody.readyToReview.length} ready videos`);

    // ==== 3. Review every video ============================================================
    phase = 'review';
    const tReview = Date.now();
    await page.goto(`${ctx.appUrl}/batch/${batchId}`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Review the first one' }).click();
    const finalEdl = new Map();
    for (const [i, id] of ids.entries()) {
      const r = recOf.get(id);
      const pv = report.perVideo[r.id];
      const t0 = Date.now();
      await page.waitForURL((u) => new URL(u).pathname === `/review/${id}`, { timeout: 30_000 });
      await seeText(page, 'Final length');
      await seeText(page, `${i + 1} of ${recs.length}`);
      let detail = await api.video(id);
      const edl0 = detail.edl;
      const clipIds = [...detail.clips].sort((a, b) => a.order - b.order).map((c) => c.id);
      assert(clipIds.length === r.manifest.clips.length, `${r.title}: ${clipIds.length} clips on the server`);
      // The rows are the EDL's, in order, in the right state.
      const want = expectedRows(edl0);
      // Screens under the current one stay mounted (hidden) on web: only this screen's rows.
      const rowsHere = page.locator('[data-testid^="row-"]').locator('visible=true');
      await waitFor(`${r.title}: transcript rows`, async () => (await rowsHere.count()) === want.length, { timeoutMs: 20_000 });
      const rowIds = await rowsHere.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid').slice(4)));
      assert(JSON.stringify(rowIds) === JSON.stringify(want), `${r.title}: rows differ from the EDL`);
      const labels = await rowsHere.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
      edl0.segments.filter(hasRow).forEach((s, k) => {
        assert(/\. Kept/.test(labels[k]) === s.keep, `${r.title}: row "${labels[k]}" shows the wrong state`);
        if (s.text.trim()) assert(labels[k].startsWith(s.text.trim()), `${r.title}: row reads "${labels[k]}", the EDL says "${s.text}"`);
      });
      pv.rows = want.length;
      pv.variants = edl0.variants.length;
      pv.fps = edl0.fps;
      pv.autoKeptSec = Math.round(resolveTimeline(edl0).durationSec * 10) / 10;

      // The automatic edit against the ground truth, and the taps that fix it.
      const problems = score(edl0, r, clipIds);
      for (const p of problems) report.mistakes.push({ video: r.id, title: r.title, kind: p.kind, reason: p.reason, text: p.unit.text, detail: describe(p) });
      const { taps: fixTaps, unfixable } = planFixes(edl0, r, clipIds, problems);
      for (const p of unfixable) {
        report.unfixable.push({ video: r.id, title: r.title, detail: describe(p), why: p.why });
        finding('unfixable_by_tapping', `${r.title}: ${describe(p)}: ${p.why}`);
      }
      pv.autoMistakes = problems.length;
      pv.fixTaps = fixTaps.length;

      // A deliberate edit on some: cut a kept line (alternating with one that carries B-roll or a
      // graphic), or restore a cut take.
      const deliberate = [];
      if (DELIBERATE.has(i)) {
        const k = [...DELIBERATE].indexOf(i);
        const afterFix = edl0.segments.map((s) => (fixTaps.includes(s.id) ? { ...s, keep: !s.keep } : s));
        const firstKept = afterFix.find((s) => s.keep)?.id;
        const kept = afterFix.filter((s) => s.keep && s.text.trim() && s.id !== firstKept && !fixTaps.includes(s.id));
        const marked = new Set(edl0.overlays.map((o) => o.anchorSegmentId));
        const restorable = afterFix.filter((s) => !s.keep && s.text.trim().split(/\s+/).length >= 2 && ['retake', 'false_start'].includes(s.reason) && !fixTaps.includes(s.id));
        let pick = null;
        let action = null;
        if (k % 2 === 1 && restorable.length) {
          pick = restorable[0];
          action = 'restore';
        } else {
          pick = (k % 4 === 0 ? kept.find((s) => marked.has(s.id)) : null) ?? kept[Math.floor(kept.length / 2)];
          action = 'cut';
        }
        assert(pick, `${r.title}: no line for a deliberate edit`);
        deliberate.push({ segmentId: pick.id, action, text: pick.text, hadOverlay: marked.has(pick.id) });
      }

      // Tap, as a creator: each row once.
      const putStatuses = [];
      const onPut = (resp) => {
        if (resp.url().endsWith(`/videos/${id}/edl`) && resp.request().method() === 'PUT') putStatuses.push(resp.status());
      };
      page.on('response', onPut);
      for (const segId of [...fixTaps, ...deliberate.map((d) => d.segmentId)]) {
        const row = page.getByTestId(`row-${segId}`).locator('visible=true');
        const before = await row.getAttribute('aria-label');
        await row.scrollIntoViewIfNeeded();
        await row.click();
        await waitFor(`${r.title}: the tapped row to flip`, async () => /\. Kept/.test(await row.getAttribute('aria-label')) !== /\. Kept/.test(before), { timeoutMs: 5000, everyMs: 100 });
      }
      // Captions on a few, from the chip in Review.
      const cap = CAPTIONS.get(i);
      if (cap) {
        await page.getByTestId('captions-chip').locator('visible=true').click();
        await page.getByTestId('captions-toggle').click();
        await page.getByRole('radio', { name: cap }).click();
        await page.getByTestId('captions-done').click();
        await seeText(page, `Captions: ${cap}`);
        report.captions.push({ video: r.id, title: r.title, style: cap.toLowerCase() });
      }
      // What the server must now hold.
      const flips = new Set([...fixTaps, ...deliberate.map((d) => d.segmentId)]);
      const wantKeep = new Map(edl0.segments.map((s) => [s.id, flips.has(s.id) ? !s.keep : s.keep]));
      const edited = flips.size > 0 || !!cap;
      if (edited) {
        detail = await waitFor(
          `${r.title}: the taps to be saved`,
          async () => {
            const d = await api.video(id);
            const ok = d.edl.segments.every((s) => s.keep === wantKeep.get(s.id)) && (!cap || (d.edl.captions.enabled && d.edl.captions.style === cap.toLowerCase()));
            return ok ? d : null;
          },
          { timeoutMs: 30_000, everyMs: 500 },
        );
      }
      page.off('response', onPut);
      const body = await bodyText(page);
      assert(!body.includes("Couldn't save"), `${r.title}: the screen says it couldn't save (PUT statuses ${putStatuses.join(',')})`);
      const bad = putStatuses.filter((s) => s !== 200 && s !== 409);
      if (bad.length) finding('save_error', `${r.title}: PUT /edl answered ${bad.join(', ')}`);
      // After the fixes the edit matches the ground truth everywhere tapping could reach.
      const left = score(detail.edl, r, clipIds).filter((p) => !deliberate.some((d) => detail.edl.segments.find((s) => s.id === d.segmentId && overlapLen([[s.start, s.end]], p.unit.start, p.unit.end) > 0)));
      const leftUnexpected = left.filter((p) => !unfixable.some((u) => u.unit === p.unit || (u.unit.text === p.unit.text && u.clip === p.clip)));
      assert(!leftUnexpected.length, `${r.title}: still wrong after tapping: ${leftUnexpected.map(describe).join('; ')}`);
      for (const d of deliberate) {
        const s = detail.edl.segments.find((x) => x.id === d.segmentId);
        assert(s.keep === (d.action === 'restore') && s.userOverride, `${r.title}: the deliberate ${d.action} of "${d.text}" was not saved`);
        report.deliberate.push({ video: r.id, title: r.title, ...d, keptSecAfter: Math.round(resolveTimeline(detail.edl).durationSec * 100) / 100 });
        ctx.log(`  ${r.title}: deliberately ${d.action === 'cut' ? 'cut' : 'restored'} "${d.text}"${d.hadOverlay ? ' (it carried B-roll or a graphic)' : ''}`);
      }
      finalEdl.set(id, detail.edl);
      mkdirSync(join(OUT, 'edls'), { recursive: true });
      writeFileSync(join(OUT, 'edls', `${r.id}.json`), JSON.stringify({ automatic: edl0, saved: detail.edl, clipIds, fixTaps, deliberate }, null, 2));
      pv.savedRevision = detail.edl.revision;
      pv.reviewSec = sec(Date.now() - t0);
      ctx.log(`  ${r.id} ${r.title}: ${want.length} rows, ${problems.length} wrong${problems.length ? ` (${problems.map((p) => p.kind + (p.reason !== 'speech' ? ':' + p.reason : '')).join(', ')})` : ''}, ${fixTaps.length} fix taps${deliberate.length ? `, 1 deliberate ${deliberate[0].action}` : ''}${cap ? `, captions ${cap}` : ''}; rev ${detail.edl.revision}; ${pv.reviewSec}s`);

      // "Looks good": the Export screen asks for the final renders of the revision reviewed.
      const renderReq = page.waitForResponse((resp) => resp.url().endsWith(`/videos/${id}/renders`) && resp.request().method() === 'POST', { timeout: 30_000 }).catch(() => null);
      await page.getByTestId('looks-good').locator('visible=true').click();
      await page.waitForURL((u) => new URL(u).pathname === `/export/${id}` && new URL(u).searchParams.get('rev') === String(detail.edl.revision), { timeout: 30_000 });
      const rr = await renderReq;
      const status = rr ? rr.status() : null;
      const errBody = rr && status >= 400 ? await rr.text() : null;
      report.exportRequests.push({ video: r.id, status, error: errBody });
      if (status !== 201 && status !== 200) {
        finding('export_refused', `${r.title}: the Export screen's render request answered ${status}${errBody ? `: ${errBody}` : ''}`);
        await seeText(page, "Couldn't start the export", 10_000);
        if (!report.shotRefused) {
          report.shotRefused = true;
          await shot(page, 'b30-08-export-refused');
        }
      }
      if (i === 0) await shot(page, 'b30-08-export-first');
      // Next video, as the Export screen offers it.
      if (i < ids.length - 1) await page.getByRole('button', { name: new RegExp(`^Next video, ${i + 2} of ${recs.length}`) }).click();
      if (i % 10 === 9) await snapshot(`after reviewing ${i + 1}`);
      save();
    }
    report.timings.reviewAllSec = sec(Date.now() - tReview);
    mark('all reviewed');
    await longTasks('review');

    // ==== 4. Every export, then every download ==============================================
    phase = 'export';
    const tExportWait = Date.now();
    // A video whose export was refused is exported again the way the app offers: Review, Looks good.
    const retried = new Set();
    await waitFor(
      'every final render to finish',
      async () => {
        const list = (await api.batch(batchId)).videos;
        for (const v of list) if (v.status === 'failed') throw new Failure(`${v.title} failed while exporting: ${v.error}`);
        const pending = list.filter((v) => v.status === 'ready_for_review');
        const busy = list.filter((v) => v.status === 'rendering').length;
        for (const v of pending.slice(0, 3)) {
          if (busy > 20) break;
          retried.add(v.id);
          await page.goto(`${ctx.appUrl}/review/${v.id}`, { waitUntil: 'networkidle' });
          await seeText(page, 'Final length');
          const rr = page.waitForResponse((resp) => resp.url().endsWith(`/videos/${v.id}/renders`) && resp.request().method() === 'POST', { timeout: 30_000 }).catch(() => null);
          await page.getByTestId('looks-good').locator('visible=true').click();
          await page.waitForURL(/\/export\//);
          const resp = await rr;
          ctx.log(`  exported ${v.title} again from Review: ${resp?.status()}`);
          report.exportRequests.push({ video: recOf.get(v.id).id, status: resp?.status() ?? null, retry: true });
        }
        return list.every((v) => v.status === 'done');
      },
      { timeoutMs: 180 * 60_000, everyMs: 5000 },
    );
    mark('all exported');
    report.timings.toAllExportedSec = sec(Date.now() - tSubmit);
    report.timings.exportWaitAfterReviewSec = sec(Date.now() - tExportWait);
    if (retried.size) report.exportRetriedVideos = retried.size;

    // Downloads: Home's Finished list -> each video's Export screen -> Download all.
    phase = 'download';
    const tDl = Date.now();
    await page.goto(ctx.appUrl + '/', { waitUntil: 'networkidle' });
    await seeText(page, 'Finished');
    const home2 = await api.home();
    const finishedOnHome = await page.getByRole('button', { name: new RegExp(`^(${recs.map((r) => r.title).join('|')}), .*(Ready to post|Posted)`) }).count();
    report.homeFinishedListed = finishedOnHome;
    ctx.log(`  Home's Finished list shows ${finishedOnHome} of ${recs.length} (GET /home recent: ${home2.recent.length})`);
    if (finishedOnHome < recs.length) finding('home_list', `Home's Finished list shows ${finishedOnHome} of ${recs.length} finished videos (GET /home returns ${home2.recent.length}); the rest cannot be reached from Home`);
    await shot(page, 'b30-09-home-finished');
    const files = [];
    for (const id of ids) {
      const r = recOf.get(id);
      const edl = finalEdl.get(id);
      const n = Math.max(1, edl.variants.length);
      await page.goto(ctx.appUrl + '/', { waitUntil: 'networkidle' });
      const row = page.getByRole('button', { name: new RegExp(`^${r.title}, .*(Ready to post|Posted)`) }).first();
      if (await row.count()) {
        await row.scrollIntoViewIfNeeded();
        await row.click();
      } else {
        // Not on Home: the Batch screen still lists it (reached by its address only; see findings).
        await page.goto(`${ctx.appUrl}/batch/${batchId}`, { waitUntil: 'networkidle' });
        await page.getByRole('button', { name: new RegExp(`^${r.title}, `) }).first().click();
      }
      await page.waitForURL((u) => new URL(u).pathname === `/export/${id}`, { timeout: 20_000 });
      const ready = page.getByRole('button', { name: /\. Tap to play$/ });
      await waitFor(`${r.title}: every version ready`, async () => (await ready.count()) === n, { timeoutMs: 60_000 });
      const downloads = [];
      const onDownload = (d) => downloads.push(d);
      page.on('download', onDownload);
      await page.getByRole('button', { name: n > 1 ? `Download all ${n}` : 'Download', exact: true }).click();
      await waitFor(`${r.title}: ${n} downloads`, () => downloads.length >= n, { timeoutMs: 120_000 });
      page.off('download', onDownload);
      const versions = edl.variants.length ? edl.variants.map((x) => ({ variantId: x.id, label: x.label })) : [{ variantId: null, label: 'Final cut' }];
      for (const [k, d] of downloads.entries()) {
        const name = d.suggestedFilename();
        const v = versions.find((x) => name.includes(x.label.replace(/\s+/g, '-'))) ?? versions[k];
        const path = join(OUT, 'downloads', `${r.id}-${name}`);
        await d.saveAs(path);
        files.push({ id, rec: r, variantId: v.variantId, label: v.label, path, name });
      }
    }
    report.timings.downloadAllSec = sec(Date.now() - tDl);
    mark(`downloaded ${files.length} files`);
    await snapshot('after downloads');

    // ==== 5. Every file =======================================================================
    phase = 'verify';
    const tVerify = Date.now();
    const verifyOne = async (f) => {
      const edl = finalEdl.get(f.id);
      const r = f.rec;
      const tl = resolveTimeline(edl, f.variantId);
      const p = await probeFile(f.path);
      const lufs = await loudness(f.path);
      const shares = await bandShares(f.path);
      const fails = [];
      if (p.width !== 1080 || p.height !== 1920) fails.push(`${p.width}x${p.height}`);
      if (Math.abs(p.fps - edl.fps) > 1e-6) fails.push(`${p.fps} fps, the EDL says ${edl.fps}`);
      if (Math.abs(p.duration - tl.durationSec) > 2 / edl.fps + 1e-6) fails.push(`duration ${p.duration.toFixed(3)}s, the saved edit is ${tl.durationSec.toFixed(3)}s`);
      if (p.audioCodec !== 'aac' || p.audioRate !== 48000) fails.push(`audio ${p.audioCodec} ${p.audioRate}`);
      if (!(Math.abs(lufs + 14) <= 1.5)) fails.push(`loudness ${lufs} LUFS`);
      // Every frame, traced through the saved edit to the fixture unit it shows.
      const clipIds = [...(await api.video(f.id)).clips].sort((a, b) => a.order - b.order).map((c) => c.id);
      const unitsOf = new Map(clipIds.map((c, j) => [c, r.manifest.clips[j].units]));
      const restored = new Set(report.deliberate.filter((d) => d.video === r.id && d.action === 'restore').map((d) => d.segmentId));
      const accepted = report.unfixable.filter((u) => u.video === r.id);
      const classify = (frame) => {
        const t = (frame + 0.5) / edl.fps;
        const it = tl.items.find((x) => t >= x.outStart && t < x.outEnd) ?? tl.items.at(-1);
        if (restored.has(it.segment.id)) return { c: 'restored', it, t };
        const src = it.segment.start + (t - it.outStart);
        const u = unitsOf.get(it.segment.clipId).find((x) => src >= x.start && src < x.end);
        if (!u) return { c: 'none', it, t };
        if (u.keep) return { c: 'kept', it, t, edge: Math.min(src - u.start, u.end - src, t - it.outStart, it.outEnd - t) };
        return { c: u.kind === 'pause' ? 'pause' : 'cut_speech', it, t, u };
      };
      const frames = Array.from({ length: p.frames }, (_, k) => classify(k));
      const cutSpeech = frames.filter((x) => x.c === 'cut_speech' && !accepted.some((a) => a.detail.includes(`"${x.u.text}"`)));
      if (cutSpeech.length) fails.push(`${cutSpeech.length} frames show cut lines (${[...new Set(cutSpeech.map((x) => `${x.u.reason} "${x.u.text}"`))].join('; ')})`);
      const pacing = PACING_PARAMS[edl.settings.pacing];
      const maxPause = pacing.keptPauseSec + 2 * pacing.cutPaddingSec + 2 / edl.fps;
      let runLen = 0;
      let longest = 0;
      for (const x of frames) {
        runLen = x.c === 'pause' ? runLen + 1 : 0;
        longest = Math.max(longest, runLen);
      }
      if (longest / edl.fps > maxPause + 1e-6) fails.push(`a kept pause of ${(longest / edl.fps).toFixed(2)}s`);
      if (shares.length !== p.frames) fails.push(`${shares.length} frames decoded, ffprobe counted ${p.frames}`);
      const under = (t) => tl.overlays.some((o) => t >= o.outStart - 0.05 && t < o.outEnd + 0.05);
      const near = (k, ok) => [k - 1, k, k + 1].some((g) => g >= 0 && g < frames.length && ok(frames[g].c));
      const orangeBad = shares.map((s, k) => [s, k]).filter(([s, k]) => s.orange > 0.03 && !near(k, (c) => c === 'pause' || c === 'restored'));
      if (orangeBad.length) fails.push(`orange cut band on ${orangeBad.length} frames that should not show it (first at ${(orangeBad[0][1] / edl.fps).toFixed(2)}s, ${frames[orangeBad[0][1]].c})`);
      // The blue kept band where the edit says a kept line plays (away from cut edges and overlays).
      const keptClear = frames.map((x, k) => [x, k]).filter(([x]) => x.c === 'kept' && x.edge > 2 / edl.fps && !under(x.t));
      const blueShown = keptClear.filter(([, k]) => shares[k]?.blue > 0.03).length;
      const blueShare = keptClear.length ? blueShown / keptClear.length : 1;
      if (keptClear.length > 10 && blueShare < 0.95) fails.push(`the kept band shows on only ${Math.round(blueShare * 100)}% of kept frames`);
      const restoredClear = frames.map((x, k) => [x, k]).filter(([x]) => x.c === 'restored' && !under(x.t));
      const restoredOrange = restoredClear.filter(([, k]) => shares[k]?.orange > 0.03).length;
      if (restoredClear.length >= 5 && restoredOrange < restoredClear.length * 0.5) fails.push(`the restored line shows on ${restoredOrange} of ${restoredClear.length} frames`);
      // A deliberately cut line is nowhere in the timeline.
      for (const d of report.deliberate.filter((x) => x.video === r.id && x.action === 'cut')) {
        if (tl.items.some((x) => x.segment.id === d.segmentId)) fails.push(`the cut line "${d.text}" is in the timeline`);
      }
      return {
        video: r.id, title: r.title, label: f.label, ok: fails.length === 0, fails,
        width: p.width, height: p.height, fps: p.fps, durationSec: Math.round(p.duration * 1000) / 1000, expectedSec: Math.round(tl.durationSec * 1000) / 1000, lufs,
        frames: p.frames, keptClearFrames: keptClear.length, blueShare: Math.round(blueShare * 1000) / 1000, restoredFrames: restoredClear.length, restoredOrange, longestKeptPauseSec: Math.round((longest / edl.fps) * 100) / 100,
      };
    };
    const queue = [...files];
    const workers = Array.from({ length: 2 }, async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        const c = await verifyOne(f);
        report.checks.push(c);
        ctx.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.video} ${c.title} ${c.label}: ${c.width}x${c.height} @ ${c.fps}, ${c.durationSec}s (edit ${c.expectedSec}s), ${c.lufs} LUFS, blue ${Math.round(c.blueShare * 100)}%${c.restoredFrames ? `, restored ${c.restoredOrange}/${c.restoredFrames}` : ''}${c.ok ? '' : ` -- ${c.fails.join('; ')}`}`);
      }
    });
    await Promise.all(workers);
    report.timings.verifySec = sec(Date.now() - tVerify);
    const deliberateVideos = new Set(report.deliberate.map((d) => d.video));
    for (const v of deliberateVideos) {
      const restoredSeen = report.checks.filter((c) => c.video === v).some((c) => c.restoredOrange > 0);
      const d = report.deliberate.find((x) => x.video === v);
      if (d.action === 'restore' && !restoredSeen) report.checks.push({ video: v, title: d.title, label: '(all)', ok: false, fails: [`the restored line "${d.text}" never shows in any version`] });
    }
    save();

    // ==== 6. Home: all finished; marking one as posted moves the goal ========================
    phase = 'home-end';
    await api.call('PUT', '/goal', { videosPerWeek: 5, reminder: { enabled: false, hour: 18, timeZone: 'UTC' } });
    await page.goto(ctx.appUrl + '/', { waitUntil: 'networkidle' });
    await seeText(page, '0 of 5 videos posted');
    const home3 = await api.home();
    assert(home3.readyToReview.length === 0 && home3.activeBatches.length === 0, `Home still has ${home3.readyToReview.length} to review and ${home3.activeBatches.length} active batches`);
    const doneAll = (await api.videos('?status=done')).videos.filter((v) => v.batchId === batchId).length;
    assert(doneAll === recs.length, `${doneAll} of ${recs.length} videos are done`);
    const finishedRows = await page.getByRole('button', { name: new RegExp(`^(${recs.map((r) => r.title).join('|')}), .*(Ready to post|Posted)`) }).count();
    report.homeFinishedListedEnd = finishedRows;
    const first = recOf.get(ids[0]);
    await page.getByRole('button', { name: new RegExp(`^${first.title}, `) }).first().click();
    await page.waitForURL(/\/export\//);
    await page.getByRole('button', { name: 'I posted this, mark as posted' }).click();
    await seeText(page, 'Marked as posted');
    await page.goto(ctx.appUrl + '/', { waitUntil: 'networkidle' });
    await seeText(page, '1 of 5 videos posted');
    assert((await api.goal()).postedThisWeek === 1, 'the goal did not count the post');
    await shot(page, 'b30-10-home-end');
    await snapshot('end');
    await longTasks('end');
    mark('done');

    // ==== Measurements ========================================================================
    const analyses = (await jobTimes(ctx.databaseUrl, 'video.analyze')).filter((j) => recOf.has(j.data.videoId) && j.state === 'completed');
    const renders = await jobTimes(ctx.databaseUrl, 'render.run');
    const renderRows = await psql(ctx.databaseUrl, `select id, video_id, quality, status, duration_sec from renders where user_id = '${userId}'`);
    const finalIds = new Set(renderRows.filter((x) => x[2] === 'final').map((x) => x[0]));
    const renderDone = renders.filter((j) => finalIds.has(j.data.renderId) && j.state === 'completed');
    for (const j of analyses) report.perVideo[recOf.get(j.data.videoId).id].analysisSec = Math.round(j.sec * 10) / 10;
    const byVideo = new Map();
    for (const j of renderDone) {
      const vid = renderRows.find((x) => x[0] === j.data.renderId)[1];
      byVideo.set(vid, [...(byVideo.get(vid) ?? []), j.sec]);
    }
    for (const [vid, list] of byVideo) report.perVideo[recOf.get(vid).id].renderSec = list.map((s) => Math.round(s * 10) / 10);
    report.analysisSec = spread(analyses.map((j) => Math.round(j.sec * 10) / 10));
    report.renderSec = spread(renderDone.map((j) => Math.round(j.sec * 10) / 10));
    report.renderSecPerOutputSec = spread(
      renderDone.map((j) => {
        const row = renderRows.find((x) => x[0] === j.data.renderId);
        return Math.round((j.sec / Number(row[4] || 1)) * 100) / 100;
      }),
    );
    report.jobRetries = [...analyses, ...renders].filter((j) => j.retries > 0).length;
    report.totalWallSec = sec(Date.now() - T0);
    report.mistakeKinds = report.mistakes.reduce((m, x) => ((m[`${x.kind}${x.reason !== 'speech' ? ':' + x.reason : ''}`] = (m[`${x.kind}${x.reason !== 'speech' ? ':' + x.reason : ''}`] ?? 0) + 1), m), {});
    report.failedResponses = failedResponses;
    report.browserErrors = errors.slice(0, 50);
    save();
    summarize(ctx, report);

    const failedChecks = report.checks.filter((c) => !c.ok);
    assert(!failedChecks.length, `${failedChecks.length} of ${report.checks.length} files failed their checks: ${failedChecks.slice(0, 4).map((c) => `${c.title} ${c.label}: ${c.fails.join('; ')}`).join(' | ')}`);
    assert(!report.unfixable.length, `${report.unfixable.length} automatic mistakes could not be fixed by tapping: ${report.unfixable.map((u) => `${u.title}: ${u.detail} (${u.why})`).join(' | ')}`);
    assert(report.findings.length === 0, `${report.findings.length} findings: ${report.findings.map((f) => f.text).join(' | ')}`);
    assert(!errors.length, `browser errors: ${errors.slice(0, 5).join(' | ')}`);
  } finally {
    sampling = false;
    await sampler.catch(() => {});
    report.totalWallSec ??= sec(Date.now() - T0);
    save();
    await browser.close();
  }
}

function summarize(ctx, r) {
  const t = r.timings;
  ctx.log('\n  ---- batch30 summary ----');
  ctx.log(`  ${r.videos} videos, ${r.clips} clips, ${r.broll} B-roll, ${r.sourceSec}s of footage, mode ${r.mode}, 3 hooks`);
  ctx.log(`  wall ${r.totalWallSec}s; all uploaded ${t.uploadSec}s, all ready ${t.toAllReadySec}s, all exported ${t.toAllExportedSec}s after submitting; review of all ${t.reviewAllSec}s; downloads ${t.downloadAllSec}s; checks ${t.verifySec}s`);
  ctx.log(`  analysis per video (s): ${JSON.stringify(r.analysisSec)}; render per version (s): ${JSON.stringify(r.renderSec)}; render s per output s: ${JSON.stringify(r.renderSecPerOutputSec)}`);
  ctx.log(`  disk peak: storage ${r.disk.peakStorageMB} MB, job dirs ${r.disk.peakJobsMB} MB, together ${r.disk.peakTotalMB} MB`);
  ctx.log(`  automatic-edit mistakes: ${r.mistakes.length} ${JSON.stringify(r.mistakeKinds)}; unfixable by tapping: ${r.unfixable.length}; deliberate edits: ${r.deliberate.length}; captions on: ${r.captions.length}`);
  ctx.log(`  files: ${r.checks.filter((c) => c.ok).length} of ${r.checks.length} pass; findings: ${r.findings.length}`);
}
