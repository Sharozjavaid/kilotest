import { resolve } from 'node:path';
import { DEFAULT_MAX_UPLOAD_BYTES } from './uploads.js';

/** How long a running job may go without a heartbeat before it is retried, seconds. */
export const DEFAULT_JOB_EXPIRE_SEC = 90;

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
  /** Largest JSON request body, bytes (`KILO_MAX_BODY_BYTES`, default 2 MiB). File bytes go to upload targets, not here. */
  maxBodyBytes: number;
  /** Per-user limits; 0 turns one off. */
  limits: Limits;
  /** A running job not heard from for this long is retried by another worker, seconds (`KILO_JOB_EXPIRE_SEC`). */
  jobExpireSec: number;
  /** Storage prefixes with no video are removed only once nothing in them is younger than this, seconds (`KILO_SWEEP_GRACE_SEC`). */
  sweepGraceSec: number;
  /** `KILO_ALLOW_STAND_INS=1`: allow an offline transcriber or decider in production. */
  allowStandIns: boolean;
}

export interface Limits {
  /** Videos uploading, queued or analysing at once (`KILO_MAX_ACTIVE_VIDEOS`). */
  activeVideos: number;
  /**
   * Renders queued or rendering at once (`KILO_MAX_QUEUED_RENDERS`). The default fits a whole
   * batch exported at once: 50 videos (the most a batch holds) with 5 openings each, plus previews.
   * Jobs are served round-robin between users, so a long queue holds up nobody else.
   */
  queuedRenders: number;
  /** Replans of one video in an hour (`KILO_MAX_REPLANS_PER_HOUR`). */
  replansPerHour: number;
  /** New batches in 24 hours (`KILO_MAX_BATCHES_PER_DAY`). */
  batchesPerDay: number;
}

export const DEFAULT_LIMITS: Limits = { activeVideos: 150, queuedRenders: 300, replansPerHour: 12, batchesPerDay: 40 };
export const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

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
  // No default: a server that forgot to choose would otherwise accept `dev:<id>` tokens from anyone.
  if (!env.KILO_AUTH) throw new Error('KILO_AUTH must be set: supabase, or dev for local runs (npm run dev sets it)');
  const port = int(env.PORT, 8787, 'PORT');
  const config: Config = {
    nodeEnv,
    databaseUrl: env.DATABASE_URL ?? '',
    port,
    publicUrl: (env.KILO_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, ''),
    auth: oneOf(env.KILO_AUTH, ['dev', 'supabase'] as const, 'supabase', 'KILO_AUTH'),
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
    maxBodyBytes: Math.max(1024, int(env.KILO_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES, 'KILO_MAX_BODY_BYTES')),
    limits: {
      activeVideos: int(env.KILO_MAX_ACTIVE_VIDEOS, DEFAULT_LIMITS.activeVideos, 'KILO_MAX_ACTIVE_VIDEOS'),
      queuedRenders: int(env.KILO_MAX_QUEUED_RENDERS, DEFAULT_LIMITS.queuedRenders, 'KILO_MAX_QUEUED_RENDERS'),
      replansPerHour: int(env.KILO_MAX_REPLANS_PER_HOUR, DEFAULT_LIMITS.replansPerHour, 'KILO_MAX_REPLANS_PER_HOUR'),
      batchesPerDay: int(env.KILO_MAX_BATCHES_PER_DAY, DEFAULT_LIMITS.batchesPerDay, 'KILO_MAX_BATCHES_PER_DAY'),
    },
    jobExpireSec: Math.max(10, int(env.KILO_JOB_EXPIRE_SEC, DEFAULT_JOB_EXPIRE_SEC, 'KILO_JOB_EXPIRE_SEC')),
    sweepGraceSec: Math.max(3600, int(env.KILO_SWEEP_GRACE_SEC, 6 * 3600, 'KILO_SWEEP_GRACE_SEC')),
    allowStandIns: env.KILO_ALLOW_STAND_INS === '1',
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
  if (config.nodeEnv === 'production' && config.storage === 'local') {
    // The generated secret file works, but in production a secret must be chosen on purpose.
    const s = config.localSigningSecret;
    if (!s || s.length < 32 || PLACEHOLDER_SECRETS.has(s.toLowerCase())) {
      throw new Error('KILO_STORAGE=local in production needs KILO_LOCAL_SIGNING_SECRET set to a random value of at least 32 characters');
    }
  }
}

const PLACEHOLDER_SECRETS = new Set(['changeme', 'change-me', 'secret', 'test-secret', 'dev', 'development', 'kilo', 'password']);

/** What `describeProviders()` from @kilo/analyze reports, as far as the server needs it. */
export interface ProviderSummary {
  standIns: string[];
  summary: string;
}

/**
 * Refuses a production worker whose transcriber or decider is an offline stand-in
 * (fixture transcripts, the heuristic decider, the fake pipeline), unless
 * KILO_ALLOW_STAND_INS=1 says that is intended.
 */
export function assertProviders(config: Config, report: ProviderSummary | null, role: { worker: boolean }): void {
  if (config.nodeEnv !== 'production' || !role.worker || config.allowStandIns) return;
  if (!report) throw new Error('The pipeline cannot say which providers it uses (KILO_PIPELINE=fake?); set KILO_ALLOW_STAND_INS=1 to run it in production');
  const bad = report.standIns.filter((r) => r === 'transcriber' || r === 'decider');
  if (bad.length) {
    throw new Error(`In production the ${bad.join(' and ')} must be a real service (${report.summary}); set KILO_ALLOW_STAND_INS=1 to allow stand-ins`);
  }
}
