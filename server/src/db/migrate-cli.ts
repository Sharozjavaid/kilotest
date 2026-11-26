import { connect } from './index.js';
import { migrate } from './migrate.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
const sql = connect(url, { max: 1 });
try {
  const result = await migrate(sql, undefined, (line) => console.log(line));
  if (!result.applied.length) console.log('nothing to apply');
} catch (err) {
  console.error('migration failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
