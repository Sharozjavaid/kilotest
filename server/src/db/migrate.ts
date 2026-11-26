import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from './index.js';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

const REQUIRES = /^--\s*kilo:requires-schema\s+(\w+)/m;

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

/**
 * Applies `migrations/*.sql` in name order inside one transaction, and
 * records them in `kilo_migrations`. A file whose header says
 * `-- kilo:requires-schema <name>` runs only when that schema exists, and is not
 * recorded otherwise, so it applies on a later run once the schema appears.
 */
export async function migrate(sql: Sql, dir = MIGRATIONS_DIR, log: (line: string) => void = () => {}): Promise<MigrateResult> {
  await sql`create table if not exists kilo_migrations (name text primary key, applied_at timestamptz not null default now())`;
  // One runner at a time across processes.
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(724100)`;
    const done = new Set((await tx<{ name: string }[]>`select name from kilo_migrations`).map((r) => r.name));
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const result: MigrateResult = { applied: [], skipped: [] };
    for (const file of files) {
      if (done.has(file)) continue;
      const text = readFileSync(join(dir, file), 'utf8');
      const requires = REQUIRES.exec(text)?.[1];
      if (requires) {
        const [row] = await tx<{ exists: boolean }[]>`select exists (select 1 from pg_namespace where nspname = ${requires}) as exists`;
        if (!row?.exists) {
          result.skipped.push(file);
          log(`skip ${file} (no ${requires} schema)`);
          continue;
        }
      }
      await tx.unsafe(text);
      await tx`insert into kilo_migrations (name) values (${file})`;
      result.applied.push(file);
      log(`applied ${file}`);
    }
    return result;
  }) as Promise<MigrateResult>;
}
