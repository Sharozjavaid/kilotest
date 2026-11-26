import { resolve } from 'node:path';
import { DEFAULT_MAX_UPLOAD_BYTES } from './uploads.js';

/** Everything the server reads from the environment, in one place. */
export interface Config {
  nodeEnv: string;
  databaseUrl: string;
  port: number;
  publicUrl: string;
  auth: 'dev' | 'supabase';
  storage: 'local' | 'supabase';
  storageDir: string;
  bucket: string;
  supabaseUrl?: string;
  supabaseServiceRoleKey?: string;
  supabaseAnonKey?: string;
  supabaseJwtSecret?: string;
  expoAccessToken?: string;
  push: 'expo' | 'log';
  pipeline: 'real' | 'fake';
  workDir: string;
  analyzeConcurrency: number;
  renderConcurrency: number;
  jobRetryLimit: number;
  /** HMAC secret for local storage links; unset means a stable one kept under the storage directory. */
  localSigningSecret?: string;
  /** Largest file one upload may carry, bytes. */
  maxUploadBytes: number;
  /** Lifetime of signed download URLs, seconds. */
  urlTtlSec: number;
  /** Browser origins allowed by CORS (`KILO_CORS_ORIGINS`, comma separated); empty allows any. */
  corsOrigins: string[];
}

function int(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T, name: string): T {
  if (value === undefined || value === '') return fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${name} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const port = int(env.PORT, 8787, 'PORT');
  const config: Config = {
    nodeEnv,
    databaseUrl: env.DATABASE_URL ?? '',
    port,
    publicUrl: (env.KILO_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, ''),
    auth: oneOf(env.KILO_AUTH, ['dev', 'supabase'] as const, 'dev', 'KILO_AUTH'),
    storage: oneOf(env.KILO_STORAGE, ['local', 'supabase'] as const, 'local', 'KILO_STORAGE'),
    storageDir: resolve(env.KILO_STORAGE_DIR ?? '.work/storage'),
    bucket: env.KILO_BUCKET || 'kilo',
    supabaseUrl: env.SUPABASE_URL?.replace(/\/+$/, ''),
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    supabaseAnonKey: env.SUPABASE_ANON_KEY,
    supabaseJwtSecret: env.SUPABASE_JWT_SECRET,
    expoAccessToken: env.EXPO_ACCESS_TOKEN,
    push: oneOf(env.KILO_PUSH, ['expo', 'log'] as const, nodeEnv === 'test' ? 'log' : 'expo', 'KILO_PUSH'),
    pipeline: oneOf(env.KILO_PIPELINE, ['real', 'fake'] as const, 'real', 'KILO_PIPELINE'),
    workDir: resolve(env.KILO_WORK_DIR ?? '.work/jobs'),
    analyzeConcurrency: Math.max(1, int(env.KILO_ANALYZE_CONCURRENCY, 1, 'KILO_ANALYZE_CONCURRENCY')),
    renderConcurrency: Math.max(1, int(env.KILO_RENDER_CONCURRENCY, 1, 'KILO_RENDER_CONCURRENCY')),
    jobRetryLimit: int(env.KILO_JOB_RETRY_LIMIT, 2, 'KILO_JOB_RETRY_LIMIT'),
    localSigningSecret: env.KILO_LOCAL_SIGNING_SECRET || undefined,
    maxUploadBytes: Math.max(1, int(env.KILO_MAX_UPLOAD_BYTES, DEFAULT_MAX_UPLOAD_BYTES, 'KILO_MAX_UPLOAD_BYTES')),
    urlTtlSec: int(env.KILO_URL_TTL_SEC, 3600, 'KILO_URL_TTL_SEC'),
    corsOrigins: (env.KILO_CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  };
  return config;
}

/** Checks that the settings needed for a role are present. Throws with a readable message. */
export function assertConfig(config: Config, role: { api: boolean; worker: boolean }): void {
  const missing: string[] = [];
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (config.auth === 'dev' && config.nodeEnv === 'production') {
    throw new Error('KILO_AUTH=dev is not allowed when NODE_ENV=production');
  }
  // Supabase tokens are checked against the JWT secret (HS256) and/or the project's JWKS (needs SUPABASE_URL).
  if (role.api && config.auth === 'supabase' && !config.supabaseJwtSecret && !config.supabaseUrl) {
    missing.push('SUPABASE_URL (for signing keys) or SUPABASE_JWT_SECRET');
  }
  if (config.storage === 'supabase') {
    if (!config.supabaseUrl) missing.push('SUPABASE_URL');
    if (!config.supabaseServiceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  }
  if (missing.length) throw new Error(`Missing environment: ${missing.join(', ')}`);
}
