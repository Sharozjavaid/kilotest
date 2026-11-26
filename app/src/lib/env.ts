/**
 * App environment (docs/CONTRACTS.md, "App environment"). EXPO_PUBLIC_* values are
 * inlined at build time, so they must be read with literal `process.env.X` access.
 */
export const env = {
  apiUrl: (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8787').replace(/\/+$/, ''),
  supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL ?? '',
  supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '',
  mock: process.env.EXPO_PUBLIC_MOCK === '1',
};

/** Which sign-in the app uses. */
export type AuthMode = 'mock' | 'supabase' | 'dev';

export function authMode(): AuthMode {
  if (env.mock) return 'mock';
  if (env.supabaseUrl) return 'supabase';
  return 'dev';
}
