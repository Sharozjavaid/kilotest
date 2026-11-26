import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import PgBoss from 'pg-boss';
import postgres from 'postgres';
import type { GlobalSetupContext } from 'vitest/node';
import { migrate } from '../src/db/migrate.js';
import type { Sql } from '../src/db/index.js';

const here = dirname(fileURLToPath(import.meta.url));

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
    pgTemplate: string;
  }
}

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

/** Starts the throwaway cluster if needed and builds a migrated template database for this run. */
export default async function setup({ provide }: GlobalSetupContext) {
  const out = execFileSync('bash', [join(here, '..', 'scripts', 'dev-db.sh')], { encoding: 'utf8' });
  const adminUrl = /DATABASE_URL=(\S+)/.exec(out)?.[1];
  if (!adminUrl) throw new Error(`dev-db.sh printed no DATABASE_URL:\n${out}`);
  const template = `kilo_tmpl_${process.pid}_${Date.now()}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  // Drop leftovers of earlier runs.
  const stale = await admin<{ datname: string }[]>`select datname from pg_database where datname like 'kilo_t%'`;
  for (const { datname } of stale) {
    await admin.unsafe(`drop database if exists "${datname}" with (force)`).catch(() => {});
  }
  await admin.unsafe(`create database "${template}"`);
  const tmplUrl = withDatabase(adminUrl, template);
  const sql = postgres(tmplUrl, { max: 1, onnotice: () => {} }) as unknown as Sql;
  await migrate(sql);
  await sql.end();
  // Install pg-boss's schema once so each test database starts with it.
  const boss = new PgBoss({ connectionString: tmplUrl, max: 1, schedule: false, supervise: false });
  await boss.start();
  await boss.stop({ graceful: false, wait: true });
  provide('pgAdminUrl', adminUrl);
  provide('pgTemplate', template);
  return async () => {
    await admin.unsafe(`drop database if exists "${template}" with (force)`).catch(() => {});
    await admin.end();
  };
}
