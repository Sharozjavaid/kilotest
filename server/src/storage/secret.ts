import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SECRET_FILE = '.local-signing-secret';

/**
 * The HMAC secret for local storage links when KILO_LOCAL_SIGNING_SECRET is unset:
 * read from `<storageDir>/.local-signing-secret`, created on first use, so links and
 * upload targets survive a restart and the API and worker processes agree. The file
 * sits beside the bucket directory, outside every storage key.
 */
export function stableSigningSecret(storageDir: string): string {
  const file = join(storageDir, SECRET_FILE);
  const read = () => {
    try {
      const s = readFileSync(file, 'utf8').trim();
      return s.length >= 32 ? s : null;
    } catch {
      return null;
    }
  };
  const existing = read();
  if (existing) return existing;
  mkdirSync(storageDir, { recursive: true });
  const secret = randomBytes(32).toString('hex');
  try {
    writeFileSync(file, secret, { mode: 0o600, flag: 'wx' });
    return secret;
  } catch {
    // Another process created it first (or it is unreadable garbage we must not overwrite).
    const again = read();
    if (again) return again;
    throw new Error(`Cannot read or create the local signing secret at ${file}`);
  }
}
