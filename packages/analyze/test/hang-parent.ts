/**
 * A worker stand-in for the signal test: starts children that never finish (a real
 * ffmpeg reading an endless source, and a shell with a grandchild), prints "ready",
 * then waits. The test sends it SIGTERM or SIGINT. Usage: node --import tsx test/hang-parent.ts <marker>
 */
import { FFMPEG, run } from '../src/ffmpeg.js';
import { spawnChecked } from '../src/proc.js';

const marker = process.argv[2] ?? 'kilo-hang';
// "handled": the host has its own shutdown handler, so the process stays up and the runs fail.
if (process.argv[3] === 'handled') {
  process.on('SIGTERM', () => setTimeout(() => process.exit(0), 1500));
  process.on('SIGINT', () => setTimeout(() => process.exit(0), 1500));
}
const results: string[] = [];
const ff = run(FFMPEG, ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=16x16', '-metadata', `title=${marker}`, '-f', 'null', '-'], { timeoutMs: 600_000 })
  .then(() => results.push('ffmpeg finished'), (e: Error) => results.push(`ffmpeg: ${e.name}`));
const sh = spawnChecked('sh', ['-c', `sleep 997 & sleep 998; wait`, marker], { timeoutMs: 600_000 })
  .then(() => results.push('sh finished'), (e: Error) => results.push(`sh: ${e.name}`));
setTimeout(() => console.log('ready'), 500);
void Promise.all([ff, sh]).then(() => console.log(results.join(';')));
setInterval(() => {}, 1000);
