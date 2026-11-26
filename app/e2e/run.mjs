// Runs every end-to-end flow against a real server: starts PostgreSQL (server/scripts/dev-db.sh),
// a fresh database, the server in dev mode with the real pipeline, local storage and dev auth, a
// static web export of the app pointed at it, then drives the flows with Playwright and tears it
// all down. `npm run e2e` in app/. Options (environment):
//   E2E_ONLY=upload,review   run only these flows (later flows need the earlier ones' state)
//   E2E_SKIP_BUILD=1         reuse the last web export in .work/e2e/web
//   E2E_API_PORT / E2E_WEB_PORT   ports (default 8791 / 8792)
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { APP_DIR, SERVER_DIR, WORK, SHOTS, Failure, apiClient, run, sleep, waitFor } from './lib.mjs';
import { startStatic } from './serve.mjs';

const API_PORT = Number(process.env.E2E_API_PORT ?? 8791);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 8792);
const API_URL = `http://localhost:${API_PORT}`;
const DB_NAME = 'kilo_e2e';

const FLOWS = ['upload', 'review', 'broll', 'export', 'recorder', 'styles', 'failures'];
const only = process.env.E2E_ONLY ? process.env.E2E_ONLY.split(',').map((s) => s.trim()) : FLOWS;

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
  const control = {
    url: API_URL,
    async start() {
      if (child) return;
      child = spawn(join(SERVER_DIR, 'node_modules', '.bin', 'tsx'), ['src/main.ts', 'dev'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.pipe(out, { end: false });
      child.stderr.pipe(out, { end: false });
      const c = child;
      c.on('exit', (code) => {
        out.write(`--- server exited ${code}\n`);
        if (child === c) child = null;
      });
      await waitFor('the server to answer /v1/health', async () => (await fetch(`${API_URL}/v1/health`)).ok, { timeoutMs: 60_000 });
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
  if (process.env.E2E_SKIP_BUILD === '1' && existsSync(join(outDir, 'index.html'))) return outDir;
  log(`building the web export for ${API_URL}`);
  const env = { ...process.env, EXPO_OFFLINE: '1', EXPO_PUBLIC_API_URL: API_URL, CI: '1' };
  for (const k of ['EXPO_PUBLIC_MOCK', 'EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY']) delete env[k];
  await run(join(APP_DIR, 'node_modules', '.bin', 'expo'), ['export', '--platform', 'web', '--output-dir', outDir, '--clear'], {
    cwd: APP_DIR,
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return outDir;
}

// ---- Main ----------------------------------------------------------------------------------
process.on('unhandledRejection', (e) => log(`unhandled rejection: ${e?.stack ?? e}`));
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
    userId,
    api: apiClient(API_URL, userId),
    state: {},
    dialogs: [],
    log,
  };
  log(`api ${API_URL}  app ${ctx.appUrl}  user ${userId}`);
  for (const name of FLOWS) {
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
  await web?.close();
  await server?.stop();
}

log('\nSummary');
for (const r of results) log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.sec !== undefined ? ` (${r.sec}s)` : ''}${r.ok ? '' : `  ${String(r.error).split('\n')[0]}`}`);
log(`total ${Math.round((Date.now() - t0) / 1000)}s; logs in ${WORK}; screenshots in ${SHOTS}`);
writeFileSync(join(WORK, 'results.json'), JSON.stringify(results, null, 2));
logFile.end();
process.exit(results.length && results.every((r) => r.ok) ? 0 : 1);
