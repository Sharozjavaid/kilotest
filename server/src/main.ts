import { loadConfig } from './config.js';
import { consoleLogger } from './log.js';
import { loadPipeline } from './pipeline/index.js';
import { startServer } from './server.js';

const mode = process.argv[2] ?? 'dev';
if (!['api', 'worker', 'dev'].includes(mode)) {
  console.error('usage: tsx src/main.ts api|worker|dev');
  process.exit(2);
}
const log = consoleLogger(mode);
try {
  const config = loadConfig();
  const pipeline = await loadPipeline(config.pipeline);
  const server = await startServer({
    config,
    pipeline,
    api: mode !== 'worker',
    worker: mode !== 'api',
    log,
    migrate: mode === 'dev',
  });
  const shutdown = async () => {
    log.info('shutting down');
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (err) {
  log.error('failed to start', { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}
