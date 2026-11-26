import postgres from 'postgres';

export type Sql = postgres.Sql<Record<string, never>>;
export type Tx = postgres.TransactionSql<Record<string, never>>;
/** Either the pool or a transaction: query helpers accept both. */
export type Db = Sql | Tx;
/** A SQL fragment built with the db tag, for composing WHERE clauses. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Fragment = postgres.PendingQuery<any>;

export function connect(databaseUrl: string, options: { max?: number } = {}): Sql {
  return postgres(databaseUrl, {
    max: options.max ?? 10,
    onnotice: () => {},
    // Supabase's pooler (transaction mode) does not support prepared statements.
    prepare: !/pooler\.supabase\.com/.test(databaseUrl),
    connection: { application_name: 'kilo-server' },
  }) as Sql;
}
