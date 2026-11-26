-- kilo:requires-schema auth
-- Row-level security for Supabase. Applied only where the `auth` schema exists
-- (Supabase), and recorded only once applied, so a plain Postgres skips it.
-- The server connects as the table owner and is not subject to these policies;
-- they protect the tables if a client ever talks to the database directly.

do $$
declare
  t text;
begin
  foreach t in array array['batches', 'videos', 'clips', 'transcripts', 'edls', 'broll_assets',
                           'renders', 'styles', 'goals', 'posts', 'devices']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_owner', t);
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format(
        'create policy %I on %I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())',
        t || '_owner', t);
    else
      execute format(
        'create policy %I on %I for all using (user_id = auth.uid()) with check (user_id = auth.uid())',
        t || '_owner', t);
    end if;
  end loop;
end
$$;
