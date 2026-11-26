-- kilo:requires-schema auth
-- Closes the database to Supabase's client roles. Supabase exposes `public` to the
-- `anon` and `authenticated` roles through its REST API, and the app ships the anon
-- key, so any policy that lets a signed-in user write a row lets them forge renders,
-- EDLs and statuses the server would then trust. The app uses Supabase only to sign
-- in; every read and write goes through the Kilo API, which connects as the table
-- owner. So: no privileges for the client roles on anything in `public` (or pg-boss's
-- schema), now or for tables created later, and row-level security on with no
-- policies, so even a stray grant exposes nothing.

do $$
declare
  t record;
  p record;
  r text;
begin
  for p in select policyname, tablename from pg_policies where schemaname = 'public' loop
    execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename);
  end loop;
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
      execute format('alter default privileges in schema public revoke all on tables from %I', r);
      execute format('alter default privileges in schema public revoke all on sequences from %I', r);
      execute format('alter default privileges in schema public revoke all on functions from %I', r);
      if exists (select 1 from pg_namespace where nspname = 'pgboss') then
        execute format('revoke all on all tables in schema pgboss from %I', r);
        execute format('revoke all on all sequences in schema pgboss from %I', r);
        execute format('revoke all on schema pgboss from %I', r);
      end if;
    end if;
  end loop;
end
$$;
