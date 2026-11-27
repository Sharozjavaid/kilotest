import { formatBroll, runBrollProxy } from './broll.js';

/** Phase 3 proxy: how often B-roll lands on the line it obviously belongs to, within the rules. */
const rs = await runBrollProxy();
console.log(formatBroll(rs));
process.exitCode = rs.some((r) => r.problems.some((p) => !p.startsWith('its line'))) ? 1 : 0;
