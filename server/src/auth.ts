import { createHmac, timingSafeEqual } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID.test(s);

/** Turns a bearer token into a user id, or null when it is not acceptable. */
export type Authenticator = (token: string) => Promise<string | null>;

/** `dev:<user uuid>`. Local runs and tests only. */
export const devAuth: Authenticator = async (token) => {
  if (!token.startsWith('dev:')) return null;
  const id = token.slice(4).toLowerCase();
  return isUuid(id) ? id : null;
};

/**
 * Supabase access tokens signed with the project's JWT secret (HS256). The user id
 * is `sub`; the token must be unexpired and for the `authenticated` role/audience.
 *
 * Not yet exercised against a real Supabase project; tested with locally signed tokens.
 * Projects that moved to asymmetric signing keys (RS256/ES256 via JWKS) need a JWKS
 * verifier here instead.
 */
export function supabaseAuth(secret: string, now: () => number = () => Date.now()): Authenticator {
  const key = Buffer.from(secret, 'utf8');
  return async (token) => {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts as [string, string, string];
    let header: { alg?: string };
    let payload: { sub?: unknown; exp?: unknown; nbf?: unknown; aud?: unknown; role?: unknown };
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
      payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (header.alg !== 'HS256') return null;
    const expected = createHmac('sha256', key).update(`${h}.${p}`).digest();
    const given = Buffer.from(s, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const nowSec = now() / 1000;
    if (typeof payload.exp !== 'number' || payload.exp < nowSec) return null;
    if (typeof payload.nbf === 'number' && payload.nbf > nowSec + 30) return null;
    const aud = payload.aud;
    const audOk = aud === undefined || aud === 'authenticated' || (Array.isArray(aud) && aud.includes('authenticated'));
    if (!audOk) return null;
    if (payload.role !== undefined && payload.role !== 'authenticated') return null;
    if (typeof payload.sub !== 'string' || !isUuid(payload.sub)) return null;
    return payload.sub.toLowerCase();
  };
}

/** HS256 JWT, for tests and scripts. */
export function signHs256(payload: Record<string, unknown>, secret: string): string {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const s = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${s}`;
}
