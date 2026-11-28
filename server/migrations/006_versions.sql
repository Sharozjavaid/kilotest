-- Edit versions (CONTRACTS.md section 3, "Versions"): a restore stores an earlier revision's edit as a
-- new revision, and remembers which one it brought back.
--
-- Runs on plain Postgres and on Supabase alike (no kilo:requires-schema header). It adds a column to an
-- existing table and creates nothing, so 002_rls and 005_lockdown need nothing new: row-level security
-- is per table and already on for `edls`, and 005 revoked every table privilege of `anon` and
-- `authenticated`; a new column gets no column privileges of its own. Where 002 and 005 have not run yet
-- (no auth schema so far), they cover `edls` whenever they do.

alter table edls add column if not exists restored_from integer null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'edls_restored_from_check' and conrelid = 'public.edls'::regclass) then
    alter table edls add constraint edls_restored_from_check
      check (restored_from is null or (restored_from >= 0 and restored_from < revision));
  end if;
end
$$;
