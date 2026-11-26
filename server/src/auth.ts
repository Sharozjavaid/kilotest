import { createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify, type JsonWebKey, type KeyObject } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID.test(s);

/**
 * Turns a bearer token into a user id, or null when the token is not acceptable.
 * Throws AuthUnavailableError when the token could not be checked at all (the key
 * set could not be fetched): that is the server's problem, not the token's, and the
 * API answers 503 so the app retries instead of signing the user out.
 */
export type Authenticator = (token: string) => Promise<string | null>;

export class AuthUnavailableError extends Error {
  constructor(message = 'Sign-in could not be checked right now') {
    super(message);
    this.name = 'AuthUnavailableError';
  }
}

/** `dev:<user uuid>`. Local runs and tests only. */
export const devAuth: Authenticator = async (token) => {
  if (!token.startsWith('dev:')) return null;
  const id = token.slice(4).toLowerCase();
  return isUuid(id) ? id : null;
};

interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

interface JwtClaims {
  sub?: unknown;
  exp?: unknown;
  nbf?: unknown;
  aud?: unknown;
  role?: unknown;
  iss?: unknown;
}

interface ParsedJwt {
  header: JwtHeader;
  claims: JwtClaims;
  signingInput: string;
  signature: Buffer;
}

function parseJwt(token: string): ParsedJwt | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  try {
    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as JwtHeader;
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as JwtClaims;
    if (!header || typeof header !== 'object' || !claims || typeof claims !== 'object') return null;
    return { header, claims, signingInput: `${h}.${p}`, signature: Buffer.from(s, 'base64url') };
  } catch {
    return null;
  }
}

/**
 * The claims every Supabase access token must carry: unexpired, for the
 * `authenticated` role and audience, `sub` a user uuid, and (when an issuer is
 * expected) the project's issuer.
 */
function userFromClaims(c: JwtClaims, nowMs: number, issuer?: string): string | null {
  const nowSec = nowMs / 1000;
  if (typeof c.exp !== 'number' || c.exp < nowSec) return null;
  if (typeof c.nbf === 'number' && c.nbf > nowSec + 30) return null;
  // Supabase user tokens always carry `aud: authenticated`; anything else (anon or service keys, other projects) is refused.
  const aud = c.aud;
  const audOk = aud === 'authenticated' || (Array.isArray(aud) && aud.includes('authenticated'));
  if (!audOk) return null;
  if (c.role !== undefined && c.role !== 'authenticated') return null;
  if (issuer && c.iss !== issuer) return null;
  if (typeof c.sub !== 'string' || !isUuid(c.sub)) return null;
  return c.sub.toLowerCase();
}

/**
 * Supabase access tokens signed with the project's legacy JWT secret (HS256).
 *
 * Not yet exercised against a real Supabase project; tested with locally signed tokens.
 */
export function supabaseAuth(secret: string, now: () => number = () => Date.now(), issuer?: string): Authenticator {
  const key = Buffer.from(secret, 'utf8');
  return async (token) => {
    const jwt = parseJwt(token);
    if (!jwt || jwt.header.alg !== 'HS256') return null;
    const expected = createHmac('sha256', key).update(jwt.signingInput).digest();
    if (jwt.signature.length !== expected.length || !timingSafeEqual(jwt.signature, expected)) return null;
    return userFromClaims(jwt.claims, now(), issuer);
  };
}

// ---- asymmetric keys (JWKS) -------------------------------------------------

type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface JwksOptions {
  /** `<SUPABASE_URL>/auth/v1/.well-known/jwks.json` */
  jwksUrl: string;
  /** Expected `iss` claim, normally `<SUPABASE_URL>/auth/v1`. Checked when the token has one. */
  issuer?: string;
  fetch?: FetchLike;
  now?: () => number;
  /** How long a fetched key set is trusted, ms (default 10 minutes). */
  cacheMs?: number;
  /** Shortest interval between fetches triggered by an unknown `kid`, ms (default 30 s). */
  minRefetchMs?: number;
  /** Called when the key set cannot be fetched. */
  onError?: (err: unknown) => void;
  /** Longest a key set fetch may take, ms (default 5 s). */
  fetchTimeoutMs?: number;
}

const ASYMMETRIC: Record<string, { kty: string; verify: (key: KeyObject, data: Buffer, sig: Buffer) => boolean }> = {
  RS256: { kty: 'RSA', verify: (k, d, s) => cryptoVerify('sha256', d, k, s) },
  ES256: { kty: 'EC', verify: (k, d, s) => s.length === 64 && cryptoVerify('sha256', d, { key: k, dsaEncoding: 'ieee-p1363' }, s) },
  EdDSA: { kty: 'OKP', verify: (k, d, s) => cryptoVerify(null, d, k, s) },
};

interface CachedKey {
  kid?: string;
  alg?: string;
  kty: string;
  key: KeyObject;
}

/**
 * Supabase access tokens signed with the project's asymmetric signing keys
 * (RS256, ES256 or EdDSA), verified against the project's JWKS endpoint. The key
 * set is cached and refetched when it expires or when a token names a `kid` it
 * does not hold (key rotation), at most once per `minRefetchMs`.
 *
 * Not yet exercised against a real Supabase project; tested with a locally generated
 * key pair and a mocked JWKS endpoint.
 */
export function jwksAuth(opts: JwksOptions): Authenticator {
  const now = opts.now ?? (() => Date.now());
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init) as ReturnType<FetchLike>);
  const cacheMs = opts.cacheMs ?? 10 * 60_000;
  const minRefetchMs = opts.minRefetchMs ?? 30_000;
  const fetchTimeoutMs = opts.fetchTimeoutMs ?? 5000;
  let keys: CachedKey[] = [];
  let fetchedAt = -Infinity;
  /** Last attempt, successful or not, so a broken endpoint is not asked on every request. */
  let triedAt = -Infinity;
  let lastFailed = false;
  let inflight: Promise<void> | null = null;

  const load = (): Promise<void> => {
    if (!inflight) {
      triedAt = now();
      inflight = (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
        try {
          const res = await Promise.race([
            doFetch(opts.jwksUrl, { headers: { accept: 'application/json' }, signal: controller.signal }),
            new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error(`JWKS fetch timed out after ${fetchTimeoutMs} ms`)))),
          ]);
          if (!res.ok) throw new Error(`JWKS endpoint returned ${res.status}`);
          const body = (await res.json()) as { keys?: Array<JsonWebKey & { kid?: string; alg?: string; use?: string }> };
          const next: CachedKey[] = [];
          for (const jwk of body.keys ?? []) {
            if (jwk.use && jwk.use !== 'sig') continue;
            try {
              const key = createPublicKey({ key: jwk, format: 'jwk' });
              next.push({ kid: jwk.kid, alg: jwk.alg, kty: String(jwk.kty), key });
            } catch {
              /* skip keys node cannot read */
            }
          }
          keys = next;
          fetchedAt = now();
          lastFailed = false;
        } catch (err) {
          lastFailed = true;
          opts.onError?.(err);
        } finally {
          clearTimeout(timer);
          inflight = null;
        }
      })();
    }
    return inflight;
  };

  const candidates = (h: JwtHeader): CachedKey[] => {
    const spec = ASYMMETRIC[h.alg ?? ''];
    if (!spec) return [];
    return keys.filter((k) => k.kty === spec.kty && (!k.alg || k.alg === h.alg) && (h.kid === undefined || k.kid === h.kid));
  };

  return async (token) => {
    const jwt = parseJwt(token);
    if (!jwt) return null;
    const spec = ASYMMETRIC[jwt.header.alg ?? ''];
    if (!spec) return null;
    const stale = now() - fetchedAt > cacheMs;
    const mayTry = now() - triedAt > minRefetchMs;
    if (stale && mayTry) {
      // With keys in hand, refresh in the background: one slow endpoint must not hold every request.
      if (keys.length) void load();
      else await load();
    }
    let found = candidates(jwt.header);
    if (!found.length && now() - triedAt > minRefetchMs) {
      // A kid we do not hold: the project may have rotated its keys.
      await load();
      found = candidates(jwt.header);
    }
    if (!found.length) {
      // No key to check this token with because the key set could not be fetched: not the token's fault.
      if (lastFailed || !keys.length) throw new AuthUnavailableError();
      return null;
    }
    const data = Buffer.from(jwt.signingInput);
    const ok = found.some((k) => {
      try {
        return spec.verify(k.key, data, jwt.signature);
      } catch {
        return false;
      }
    });
    return ok ? userFromClaims(jwt.claims, now(), opts.issuer) : null;
  };
}

/** The JWKS location and issuer of a Supabase project. */
export function supabaseJwks(supabaseUrl: string): { jwksUrl: string; issuer: string } {
  const base = supabaseUrl.replace(/\/+$/, '');
  return { jwksUrl: `${base}/auth/v1/.well-known/jwks.json`, issuer: `${base}/auth/v1` };
}

/**
 * Supabase auth for `KILO_AUTH=supabase`: HS256 tokens against SUPABASE_JWT_SECRET
 * when it is set, and asymmetric tokens against the project's JWKS when
 * SUPABASE_URL is set. A project that has migrated to signing keys issues the
 * latter; older sessions may still carry the former, so both are accepted.
 */
export function combinedSupabaseAuth(opts: { secret?: string; supabaseUrl?: string } & Omit<Partial<JwksOptions>, 'jwksUrl'>): Authenticator {
  // Both paths expect the project's issuer when the project URL is known.
  const issuer = opts.supabaseUrl ? supabaseJwks(opts.supabaseUrl).issuer : undefined;
  const hs = opts.secret ? supabaseAuth(opts.secret, opts.now, issuer) : null;
  const asym = opts.supabaseUrl ? jwksAuth({ ...supabaseJwks(opts.supabaseUrl), ...opts }) : null;
  if (!hs && !asym) throw new Error('Supabase auth needs SUPABASE_JWT_SECRET or SUPABASE_URL');
  return async (token) => {
    const alg = parseJwt(token)?.header.alg;
    if (alg === 'HS256') return hs ? hs(token) : null;
    return asym ? asym(token) : null;
  };
}

/** HS256 JWT, for tests and scripts. */
export function signHs256(payload: Record<string, unknown>, secret: string): string {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const s = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${s}`;
}
