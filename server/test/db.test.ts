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

  it('skips the RLS migration on plain Postgres and applies it once an auth schema exists', async () => {
    const first = await migrate(sql);
    expect(first).toEqual({ applied: ['001_init.sql'], skipped: ['002_rls.sql'] });
    expect(await migrate(sql)).toEqual({ applied: [], skipped: ['002_rls.sql'] });

    // Imitate Supabase: an auth schema with auth.uid() and the authenticated role.
    await sql.unsafe(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      end $$;
      create schema auth;
      create function auth.uid() returns uuid language sql stable
        as $f$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
      grant usage on schema auth to authenticated;
      grant usage on schema public to authenticated;
      grant select, insert, update, delete on all tables in schema public to authenticated;`);
    expect(await migrate(sql)).toEqual({ applied: ['002_rls.sql'], skipped: [] });

    const alice = randomUUID();
    const bob = randomUUID();
    const batch = (user: string) => ({ id: randomUUID(), user_id: user, settings: sql.json(DEFAULT_SETTINGS as never) });
    // The server (table owner) is not subject to RLS.
    await sql`insert into batches ${sql(batch(bob))}`;
    const asUser = async <T>(user: string, fn: (tx: postgres.TransactionSql) => Promise<T>) =>
      sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claim.sub', ${user}, true)`;
        await tx`set local role authenticated`;
        return fn(tx as unknown as postgres.TransactionSql);
      });
    await asUser(alice, (tx) => tx`insert into batches ${tx(batch(alice))}`);
    await expect(asUser(alice, (tx) => tx`insert into batches ${tx(batch(bob))}`)).rejects.toThrow(/row-level security/);
    const visible = await asUser(alice, (tx) => tx`select user_id from batches`);
    expect(visible.map((r) => r.user_id)).toEqual([alice]);
    const updated = await asUser(alice, (tx) => tx`update batches set ready_notified_at = now() where user_id = ${bob} returning id`);
    expect(updated).toHaveLength(0);
    const policies = await sql`select tablename from pg_policies where schemaname = 'public' order by tablename`;
    expect(policies.map((p) => p.tablename)).toEqual(
      ['batches', 'broll_assets', 'clips', 'devices', 'edls', 'goals', 'posts', 'renders', 'styles', 'transcripts', 'videos'].sort(),
    );
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
