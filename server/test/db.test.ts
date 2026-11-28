import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { DEFAULT_SETTINGS } from '@kilo/edl';
import { connect, type Sql } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { memoryLogger } from '../src/log.js';
import { ExpoPush, LogPush, Notifier } from '../src/push.js';

describe('migrations and row-level security', () => {
  const adminUrl = inject('pgAdminUrl');
  const name = `kilo_t_rls_${randomUUID().slice(0, 8)}`;
  let sql: Sql;

  beforeAll(async () => {
    const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database "${name}"`);
    await admin.end();
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    sql = connect(url.toString(), { max: 2 });
  });
  afterAll(async () => {
    await sql?.end();
    const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.end();
  });

  it('skips the Supabase-only migrations on plain Postgres; once an auth schema exists the client roles can reach no table', async () => {
    const first = await migrate(sql);
    expect(first).toEqual({ applied: ['001_init.sql', '003_progress.sql', '004_hardening.sql', '006_versions.sql'], skipped: ['002_rls.sql', '005_lockdown.sql'] });
    expect(await migrate(sql)).toEqual({ applied: [], skipped: ['002_rls.sql', '005_lockdown.sql'] });

    // Imitate Supabase: an auth schema with auth.uid(), the anon and authenticated roles, and the grants
    // Supabase gives them on public (today's tables and, through default privileges, tomorrow's).
    await sql.unsafe(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      end $$;
      create schema auth;
      create function auth.uid() returns uuid language sql stable
        as $f$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
      grant usage on schema auth to authenticated, anon;
      grant usage on schema public to authenticated, anon;
      grant all on all tables in schema public to authenticated, anon;
      grant all on all sequences in schema public to authenticated, anon;
      alter default privileges in schema public grant all on tables to authenticated, anon;
      alter default privileges in schema public grant all on sequences to authenticated, anon;`);
    expect(await migrate(sql)).toEqual({ applied: ['002_rls.sql', '005_lockdown.sql'], skipped: [] });

    const tables = (await sql<{ tablename: string }[]>`select tablename from pg_tables where schemaname = 'public' order by tablename`).map((r) => r.tablename);
    expect(tables).toEqual(expect.arrayContaining(['batches', 'videos', 'clips', 'transcripts', 'edls', 'broll_assets', 'renders', 'styles', 'goals', 'posts', 'devices', 'usage_events', 'kilo_migrations']));
    // Row-level security is on everywhere, with no policy left to open a door.
    const rls = await sql<{ relname: string; relrowsecurity: boolean }[]>`
      select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'`;
    expect(rls.filter((r) => !r.relrowsecurity)).toEqual([]);
    expect(await sql`select tablename from pg_policies where schemaname = 'public'`).toHaveLength(0);

    const alice = randomUUID();
    const videoId = randomUUID();
    const batchId = randomUUID();
    // The server (table owner) is not subject to any of this.
    await sql`insert into batches ${sql({ id: batchId, user_id: alice, settings: sql.json(DEFAULT_SETTINGS as never) })}`;
    await sql`insert into videos ${sql({ id: videoId, user_id: alice, batch_id: batchId, title: 't', source: 'upload', settings: sql.json(DEFAULT_SETTINGS as never) })}`;
    const as = async <T>(role: string, fn: (tx: postgres.TransactionSql) => Promise<T>) =>
      sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claim.sub', ${alice}, true)`;
        await tx.unsafe(`set local role ${role}`);
        return fn(tx as unknown as postgres.TransactionSql);
      });
    for (const role of ['authenticated', 'anon']) {
      // Not even a signed-in user's own rows can be read or written.
      for (const t of tables) {
        await expect(as(role, (tx) => tx.unsafe(`select * from public.${t} limit 1`)), `${role} select ${t}`).rejects.toThrow(/permission denied/);
        await expect(as(role, (tx) => tx.unsafe(`delete from public.${t}`)), `${role} delete ${t}`).rejects.toThrow(/permission denied/);
      }
      // The forgeries the review found: a finished render naming another user's file, an EDL, a status change.
      await expect(
        as(role, (tx) => tx`insert into renders (id, user_id, video_id, quality, status, edl_revision, output_key)
          values (${randomUUID()}, ${alice}, ${videoId}, 'final', 'done', 0, ${'users/someone-else/videos/x/renders/y.mp4'})`),
      ).rejects.toThrow(/permission denied/);
      await expect(
        as(role, (tx) => tx`insert into edls (video_id, revision, user_id, edl, author) values (${videoId}, 9, ${alice}, '{}'::jsonb, 'user')`),
      ).rejects.toThrow(/permission denied/);
      await expect(as(role, (tx) => tx`update videos set status = 'done' where id = ${videoId}`)).rejects.toThrow(/permission denied/);
      await expect(as(role, (tx) => tx`select nextval('usage_events_id_seq')`)).rejects.toThrow(/permission denied/);
    }
    // Tables created later by the same owner (the next migration) are not exposed either.
    await sql.unsafe('create table public.added_later (id int)');
    await expect(as('authenticated', (tx) => tx.unsafe('select * from public.added_later'))).rejects.toThrow(/permission denied/);
    await sql.unsafe('drop table public.added_later');
    expect((await sql`select status from videos where id = ${videoId}`)[0]!.status).toBe('uploading');
  });

  it('the notifier sends to every device of a user and forgets unregistered ones', async () => {
    const user = randomUUID();
    await sql`insert into devices (id, user_id, expo_push_token, platform) values
      (${randomUUID()}, ${user}, 'ExponentPushToken[live]', 'ios'),
      (${randomUUID()}, ${user}, 'ExponentPushToken[dead]', 'android')`;
    const sent: string[][] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      const msgs = JSON.parse(String(init.body)) as { to: string }[];
      sent.push(msgs.map((m) => m.to).sort());
      return Response.json({
        data: msgs.map((m) => (m.to.includes('dead') ? { status: 'error', details: { error: 'DeviceNotRegistered' } } : { status: 'ok' })),
      });
    }) as unknown as typeof fetch;
    const log = memoryLogger();
    const fallback = new LogPush();
    const notifier = new Notifier(sql, new ExpoPush(undefined, fetchImpl), log, fallback);
    await notifier.notify(user, { type: 'batch_ready', batchId: 'b1' });
    expect(sent).toEqual([['ExponentPushToken[dead]', 'ExponentPushToken[live]']]);
    expect((await sql`select expo_push_token from devices where user_id = ${user}`).map((r) => r.expo_push_token)).toEqual([
      'ExponentPushToken[live]',
    ]);
    // A user with no devices goes to the log provider; failures never throw.
    await notifier.notify(randomUUID(), { type: 'goal_reminder' });
    expect(fallback.sent).toHaveLength(1);
    const broken = new Notifier(sql, { name: 'x', send: async () => Promise.reject(new Error('down')) }, log);
    await expect(broken.notify(user, { type: 'goal_reminder' })).resolves.toBeUndefined();
    expect(log.lines.some((l) => l.msg === 'push failed')).toBe(true);
  });
});
