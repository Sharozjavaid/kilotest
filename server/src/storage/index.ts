import type { Config } from '../config.js';
import { LocalStorage } from './local.js';
import { stableSigningSecret } from './secret.js';
import { SupabaseStorage } from './supabase.js';
import type { StorageDriver } from './types.js';

export * from './types.js';
export { LocalStorage } from './local.js';
export { SupabaseStorage } from './supabase.js';
export { stableSigningSecret } from './secret.js';

export function createStorage(config: Config): StorageDriver {
  if (config.storage === 'supabase') {
    return new SupabaseStorage(config.supabaseUrl!, config.supabaseServiceRoleKey!, config.bucket, {
      anonKey: config.supabaseAnonKey,
      defaultTtlSec: config.urlTtlSec,
    });
  }
  const secret = config.localSigningSecret ?? stableSigningSecret(config.storageDir);
  return new LocalStorage(config.storageDir, config.bucket, config.publicUrl, secret, config.urlTtlSec);
}
