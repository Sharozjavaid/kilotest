// Runs every end-to-end flow against a real server: starts PostgreSQL (server/scripts/dev-db.sh),
// a fresh database, the server in dev mode with the real pipeline, local storage and dev auth, a
// static web export of the app pointed at it, then drives the flows with Playwright and tears it
// all down. `npm run e2e` in app/. Options (environment):
//   E2E_ONLY=upload,review   run only these flows (later flows need the earlier ones' state)
//   E2E_ONLY=batch30         the 30-video run (opt-in, about an hour; `npm run e2e:batch30`)
//   E2E_SKIP_BUILD=1         reuse the last web export in .work/e2e/web
//   E2E_API_PORT / E2E_WEB_PORT   ports (default 8791 / 8792)
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { APP_DIR, SERVER_DIR, WORK, SHOTS, Failure, apiClient, run, sleep, waitFor } from './lib.mjs';
import { startStatic } from './serve.mjs';

/** The wanted port if it is free, else any free one (the web export is built for the API port chosen). */
async function freePort(wanted) {
  const net = await import('node:net');
  const tryPort = (port) =>
    new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(null));
      srv.listen(port, () => srv.close(() => resolve(srv.address()?.port ?? port)));
    });
  return (await tryPort(wanted)) ?? (await new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  }));
}
const API_PORT = await freePort(Number(process.env.E2E_API_PORT ?? 8791));
const WEB_PORT = await freePort(Number(process.env.E2E_WEB_PORT ?? 8792));
const API_URL = `http://localhost:${API_PORT}`;
const DB_NAME = 'kilo_e2e';

const FLOWS = ['upload', 'review', 'versions', 'broll', 'export', 'recorder', 'styles', 'failures'];
// Long flows that run only when named in E2E_ONLY, after the default ones.
const OPT_IN = ['batch30'];
const only = process.env.E2E_ONLY ? process.env.E2E_ONLY.split(',').map((s) => s.trim()) : FLOWS;
const unknown = only.filter((n) => !FLOWS.includes(n) && !OPT_IN.includes(n));
if (unknown.length) {
  console.error(`unknown flow(s) in E2E_ONLY: ${unknown.join(', ')} (flows: ${[...FLOWS, ...OPT_IN].join(', ')})`);
  process.exit(2);
}

mkdirSync(WORK, { recursive: true });
const logFile = createWriteStream(join(WORK, 'e2e.log'));
const log = (...a) => {
  const line = a.join(' ');
  console.log(line);
  logFile.write(line + '\n');
};

// ---- PostgreSQL and a fresh database --------------------------------------------------
async function database() {
  const { stdout } = await run('bash', [join(SERVER_DIR, 'scripts', 'dev-db.sh')]);
  const base = /DATABASE_URL=(\S+)/.exec(stdout)?.[1];
  if (!base) throw new Error(`dev-db.sh printed no DATABASE_URL: ${stdout}`);
  const admin = base;
  const psql = (sql) => run('psql', [admin, '-v', 'ON_ERROR_STOP=1', '-q', '-c', sql]);
  await psql(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${DB_NAME}' and pid <> pg_backend_pid()`);
  await psql(`drop database if exists ${DB_NAME}`);
  await psql(`create database ${DB_NAME}`);
  return base.replace(/\/[^/]*$/, `/${DB_NAME}`);
}

// ---- The server, restartable -----------------------------------------------------------
function serverControl(databaseUrl) {
  const storageDir = join(WORK, 'storage');
  const workDir = join(WORK, 'jobs');
  rmSync(storageDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    DATABASE_URL: databaseUrl,
    PORT: String(API_PORT),
    KILO_PUBLIC_URL: API_URL,
    KILO_AUTH: 'dev',
    KILO_STORAGE: 'local',
    KILO_STORAGE_DIR: storageDir,
    KILO_WORK_DIR: workDir,
    KILO_PIPELINE: 'real',
    KILO_TRANSCRIBER: 'fixture',
    KILO_DECIDER: 'heuristic',
    KILO_PUSH: 'log',
    KILO_JOB_RETRY_LIMIT: '1',
    KILO_ANALYZE_CONCURRENCY: '1',
    KILO_RENDER_CONCURRENCY: '1',
    // Short-lived links, so the flows see the app cope with expired signed URLs.
    KILO_URL_TTL_SEC: process.env.E2E_URL_TTL_SEC ?? '120',
  };
  for (const k of ['ANTHROPIC_API_KEY', 'DEEPGRAM_API_KEY', 'OPENAI_API_KEY', 'PEXELS_API_KEY']) delete env[k];
  const out = createWriteStream(join(WORK, 'server.log'), { flags: 'a' });
  let child = null;
  // Whatever happens to this process (a crash, Ctrl-C), the server goes with it.
  process.on('exit', () => {
    if (child && child.exitCode === null) child.kill('SIGKILL');
  });
  const control = {
    url: API_URL,
    storageDir,
    workDir,
    async start() {
      if (child) return;
      child = spawn(join(SERVER_DIR, 'node_modules', '.bin', 'tsx'), ['src/main.ts', 'dev'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.pipe(out, { end: false });
      child.stderr.pipe(out, { end: false });
      const c = child;
      let exited = false;
      c.on('exit', (code) => {
        exited = true;
        out.write(`--- server exited ${code}\n`);
        if (child === c) child = null;
      });
      await waitFor('the server to answer /v1/health', async () => {
        if (exited) throw new Error(`the server exited while starting; see ${join(WORK, 'server.log')}`);
        return (await fetch(`${API_URL}/v1/health`)).ok;
      }, { timeoutMs: 60_000 });
    },
    async stop() {
      const c = child;
      if (!c) return;
      child = null;
      c.kill('SIGTERM');
      await Promise.race([new Promise((r) => c.once('exit', r)), sleep(15_000)]);
      if (c.exitCode === null) c.kill('SIGKILL');
    },
  };
  return control;
}

// ---- The web export ---------------------------------------------------------------------
async function buildApp() {
  const outDir = join(WORK, 'web');
  const marker = join(outDir, '.api-url');
  if (process.env.E2E_SKIP_BUILD === '1' && existsSync(join(outDir, 'index.html')) && existsSync(marker) && readFileSync(marker, 'utf8') === API_URL) return outDir;
  log(`building the web export for ${API_URL}`);
  const env = { ...process.env, EXPO_OFFLINE: '1', EXPO_PUBLIC_API_URL: API_URL, CI: '1' };
  for (const k of ['EXPO_PUBLIC_MOCK', 'EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY']) delete env[k];
  await run(join(APP_DIR, 'node_modules', '.bin', 'expo'), ['export', '--platform', 'web', '--output-dir', outDir, '--clear'], {
    cwd: APP_DIR,
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  writeFileSync(marker, API_URL);
  return outDir;
}

// ---- Main ----------------------------------------------------------------------------------
process.on('unhandledRejection', (e) => log(`unhandled rejection: ${e?.stack ?? e}`));
let tearingDown = null;
async function teardown() {
  tearingDown ??= (async () => {
    await web?.close().catch(() => {});
    await server?.stop().catch(() => {});
  })();
  return tearingDown;
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    log(`\n${sig}: tearing down`);
    void teardown().finally(() => process.exit(130));
  });
}
process.on('uncaughtException', (e) => {
  log(`uncaught exception: ${e?.stack ?? e}`);
  void teardown().finally(() => process.exit(1));
});
const results = [];
let server = null;
let web = null;
const t0 = Date.now();
try {
  rmSync(SHOTS, { recursive: true, force: true });
  const [databaseUrl, webDir] = await Promise.all([database(), buildApp()]);
  server = serverControl(databaseUrl);
  await server.start();
  web = await startStatic(webDir, WEB_PORT);
  const userId = randomUUID();
  const ctx = {
    apiUrl: API_URL,
    appUrl: `http://localhost:${WEB_PORT}`,
    server,
    databaseUrl,
    userId,
    api: apiClient(API_URL, userId),
    state: {},
    dialogs: [],
    log,
  };
  log(`api ${API_URL}  app ${ctx.appUrl}  user ${userId}`);
  for (const name of [...FLOWS, ...OPT_IN]) {
    if (!only.includes(name)) continue;
    const started = Date.now();
    log(`\n== ${name}`);
    try {
      const mod = await import(`./flows/${name}.mjs`);
      await mod.default(ctx);
      results.push({ name, ok: true, sec: Math.round((Date.now() - started) / 1000) });
      log(`== ${name}: PASS (${Math.round((Date.now() - started) / 1000)}s)`);
    } catch (e) {
      results.push({ name, ok: false, sec: Math.round((Date.now() - started) / 1000), error: e instanceof Failure ? e.message : e?.stack ?? String(e) });
      log(`== ${name}: FAIL (${Math.round((Date.now() - started) / 1000)}s)\n${e instanceof Failure ? e.message : e?.stack ?? e}`);
      // Later flows build on earlier ones; keep going so every independent failure shows.
    }
  }
} catch (e) {
  log(`setup failed: ${e?.stack ?? e}`);
  results.push({ name: 'setup', ok: false, error: String(e?.message ?? e) });
} finally {
  await teardown();
}

log('\nSummary');
for (const r of results) log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.sec !== undefined ? ` (${r.sec}s)` : ''}${r.ok ? '' : `  ${String(r.error).split('\n')[0]}`}`);
log(`total ${Math.round((Date.now() - t0) / 1000)}s; logs in ${WORK}; screenshots in ${SHOTS}`);
writeFileSync(join(WORK, 'results.json'), JSON.stringify(results, null, 2));
logFile.end();
process.exit(results.length && results.every((r) => r.ok) ? 0 : 1);
