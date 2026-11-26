/** Minimal structured logger. Never pass secrets in `fields`. */
export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

function serialize(fields?: Record<string, unknown>): string {
  if (!fields) return '';
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = v instanceof Error ? { message: v.message, stack: v.stack } : v;
  }
  return ' ' + JSON.stringify(out);
}

export function consoleLogger(prefix = 'kilo'): Logger {
  const line = (level: string, msg: string, fields?: Record<string, unknown>) =>
    `${new Date().toISOString()} ${level} [${prefix}] ${msg}${serialize(fields)}`;
  return {
    info: (m, f) => console.log(line('info', m, f)),
    warn: (m, f) => console.warn(line('warn', m, f)),
    error: (m, f) => console.error(line('error', m, f)),
  };
}

/** Collects lines in memory; used in tests to keep output quiet and to assert on logs. */
export function memoryLogger(): Logger & { lines: { level: string; msg: string; fields?: Record<string, unknown> }[] } {
  const lines: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
  return {
    lines,
    info: (msg, fields) => lines.push({ level: 'info', msg, fields }),
    warn: (msg, fields) => lines.push({ level: 'warn', msg, fields }),
    error: (msg, fields) => lines.push({ level: 'error', msg, fields }),
  };
}
