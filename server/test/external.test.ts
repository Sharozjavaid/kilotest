import { generateKeyPairSync, randomBytes, randomUUID, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UploadTarget } from '@kilo/edl';
import { AuthUnavailableError, combinedSupabaseAuth, devAuth, jwksAuth, signHs256, supabaseAuth, supabaseJwks } from '../src/auth.js';
import { createApp } from '../src/api/app.js';
import { assertConfig, assertProviders, loadConfig } from '../src/config.js';
import { memoryLogger } from '../src/log.js';
import { ExpoPush, LogPush } from '../src/push.js';
import { authenticatorFor } from '../src/server.js';
import { SupabaseStorage, TUS_CHUNK } from '../src/storage/supabase.js';
import { createStorage, LocalStorage, stableSigningSecret } from '../src/storage/index.js';
import { SERVER_DIR } from './helpers.js';

/** An in-memory imitation of the Supabase Storage endpoints the driver uses. Records every request. */
function fakeSupabase(serviceKey: string) {
  const objects = new Map<string, Buffer>();
  const uploads = new Map<string, { key: string; length: number; chunks: Buffer[]; offset: number }>();
  const requests: { method: string; path: string; headers: Record<string, string>; body?: unknown }[] = [];
  const base = 'https://proj.supabase.co/storage/v1';
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const path = url.pathname.replace('/storage/v1', '');
    requests.push({ method, path, headers });
    if (headers.authorization !== `Bearer ${serviceKey}` || headers.apikey !== serviceKey) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    }
    const body = init.body;
    const json = () => JSON.parse(String(body));
    let m: RegExpExecArray | null;
    if ((m = /^\/object\/upload\/sign\/kilo\/(.+)$/.exec(path)) && method === 'POST') {
      return Response.json({ url: `/object/upload/sign/kilo/${m[1]}?token=signed-${decodeURIComponent(m[1]!)}` });
    }
    if ((m = /^\/object\/sign\/kilo\/(.+)$/.exec(path)) && method === 'POST') {
      return Response.json({ signedURL: `/object/sign/kilo/${m[1]}?token=t${json().expiresIn}` });
    }
    if ((m = /^\/object\/authenticated\/kilo\/(.+)$/.exec(path))) {
      const obj = objects.get(decodeURIComponent(m[1]!).split('/').map(decodeURIComponent).join('/'));
      if (!obj) return new Response('{"error":"not found"}', { status: 400 });
      return new Response(method === 'HEAD' ? null : new Uint8Array(obj), { status: 200, headers: { 'content-length': String(obj.length) } });
    }
    if (path === '/object/list/kilo' && method === 'POST') {
      const { prefix } = json() as { prefix: string };
      const names = new Map<string, boolean>();
      for (const key of objects.keys()) {
        if (!key.startsWith(prefix + '/')) continue;
        const rest = key.slice(prefix.length + 1);
        const [head, ...tail] = rest.split('/');
        names.set(head!, tail.length > 0 || names.get(head!) === true);
      }
      return Response.json([...names].map(([name, folder]) => ({ name, id: folder ? null : `id-${name}` })));
    }
    if (path === '/object/kilo' && method === 'DELETE') {
      for (const k of (json() as { prefixes: string[] }).prefixes) objects.delete(k);
      return Response.json([]);
    }
    if ((m = /^\/object\/kilo\/(.+)$/.exec(path)) && method === 'POST') {
      objects.set(decodeURIComponent(m[1]!), Buffer.from(body as Uint8Array));
      return Response.json({ Key: m[1] });
    }
    if (path === '/upload/resumable' && method === 'POST') {
      const meta = Object.fromEntries(
        headers['upload-metadata']!.split(',').map((p) => {
          const [k, v] = p.split(' ');
          return [k, Buffer.from(v!, 'base64').toString()];
        }),
      );
      const id = randomUUID();
      uploads.set(id, { key: meta.objectName!, length: Number(headers['upload-length']), chunks: [], offset: 0 });
      return new Response(null, { status: 201, headers: { location: `${base}/upload/resumable/${id}` } });
    }
    if ((m = /^\/upload\/resumable\/(.+)$/.exec(path)) && method === 'PATCH') {
      const up = uploads.get(m[1]!)!;
      const chunk = Buffer.from(body as Uint8Array);
      if (Number(headers['upload-offset']) !== up.offset) return new Response(null, { status: 409 });
      if (up.offset + chunk.length < up.length && chunk.length !== TUS_CHUNK) return new Response(null, { status: 400 });
      up.chunks.push(chunk);
      up.offset += chunk.length;
      if (up.offset === up.length) objects.set(up.key, Buffer.concat(up.chunks));
      return new Response(null, { status: 204, headers: { 'upload-offset': String(up.offset) } });
    }
    return new Response('{"error":"no route"}', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, objects, requests };
}

describe('Supabase storage driver (mocked HTTP; not run against a real project)', () => {
  const key = 'users/u1/videos/v1/clips/c1/source.mp4';
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(SERVER_DIR, '.work', 'supa-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('hands out tus targets without the service key and signs downloads', async () => {
    const fake = fakeSupabase('service-key');
    const storage = new SupabaseStorage('https://proj.supabase.co/', 'service-key', 'kilo', { fetch: fake.fetchImpl, anonKey: 'anon' });
    const target = UploadTarget.parse(await storage.createUploadTarget(key, 'video/mp4'));
    expect(target).toEqual({
      kind: 'tus',
      url: 'https://proj.supabase.co/storage/v1/upload/resumable/sign',
      headers: { 'x-signature': `signed-${key}`, 'x-upsert': 'true', 'content-type': 'video/mp4', apikey: 'anon' },
      objectKey: key,
      bucket: 'kilo',
    });
    expect(JSON.stringify(target)).not.toContain('service-key');
    const url = await storage.signedUrl(key, 120);
    expect(url).toBe(`https://proj.supabase.co/storage/v1/object/sign/kilo/${key}?token=t120`);
  });

  it('uploads small files in one request and large ones in 6 MB tus chunks; downloads, checks and deletes', async () => {
    const fake = fakeSupabase('service-key');
    const storage = new SupabaseStorage('https://proj.supabase.co', 'service-key', 'kilo', { fetch: fake.fetchImpl });
    const small = join(dir, 'small.bin');
    const large = join(dir, 'large.bin');
    const smallBytes = randomBytes(1000);
    const largeBytes = randomBytes(TUS_CHUNK * 2 + 12345);
    await writeFile(small, smallBytes);
    await writeFile(large, largeBytes);
    expect(await storage.exists(key)).toBe(false);
    await storage.upload(key, small, 'video/mp4');
    expect(await storage.exists(key)).toBe(true);
    expect(await storage.size(key)).toBe(1000);
    expect(await storage.size('users/u1/videos/v1/nothing.mp4')).toBeNull();
    const bigKey = 'users/u1/videos/v1/renders/r1.mp4';
    await storage.upload(bigKey, large, 'video/mp4');
    expect(fake.requests.filter((r) => r.method === 'PATCH')).toHaveLength(3);
    expect(fake.objects.get(bigKey)!.equals(largeBytes)).toBe(true);
    const back = join(dir, 'back.bin');
    await storage.download(bigKey, back);
    expect((await readFile(back)).equals(largeBytes)).toBe(true);
    fake.objects.set('users/u1/videos/v1/clips/c2/thumb.jpg', Buffer.from('x'));
    fake.objects.set('users/u2/videos/v9/proxy.mp4', Buffer.from('x'));
    // The orphan sweep's listing walks users/*/videos/*; objects the API gives no time for count as new (never swept).
    const prefixes = await storage.listVideoPrefixes();
    expect(prefixes.map((p) => [p.userId, p.videoId]).sort()).toEqual([['u1', 'v1'], ['u2', 'v9']]);
    expect(prefixes.every((p) => p.newest && Date.now() - p.newest.getTime() < 60_000)).toBe(true);
    await storage.deletePrefix('users/u1/videos/v1');
    expect([...fake.objects.keys()]).toEqual(['users/u2/videos/v9/proxy.mp4']);
    await expect(storage.download('users/u1/missing.mp4', back)).rejects.toThrow(/400/);
    await expect(storage.signedUrl('../etc/passwd')).rejects.toThrow(/Unsafe/);
  });
});

describe('local signing secret', () => {
  it('is derived from a file under the storage directory, stable across restarts and processes', async () => {
    const root = await mkdtemp(join(SERVER_DIR, '.work', 'secret-'));
    try {
      const a = stableSigningSecret(root);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
      expect(stableSigningSecret(root)).toBe(a);
      expect((await readFile(join(root, '.local-signing-secret'), 'utf8')).trim()).toBe(a);
      // A link signed before a "restart" still verifies after it.
      const before = createStorage(loadConfig({ KILO_AUTH: 'dev', KILO_STORAGE_DIR: root }));
      const after = createStorage(loadConfig({ KILO_AUTH: 'dev', KILO_STORAGE_DIR: root }));
      const url = await before.signedUrl('users/u/videos/v/proxy.mp4');
      expect((after as LocalStorage).verify(url.split('/').pop()!, 'get')).toBe('users/u/videos/v/proxy.mp4');
      // An explicit secret wins and does not touch the file.
      const explicit = createStorage(loadConfig({ KILO_AUTH: 'dev', KILO_STORAGE_DIR: root, KILO_LOCAL_SIGNING_SECRET: 'x'.repeat(40) })) as LocalStorage;
      expect(explicit.verify(url.split('/').pop()!, 'get')).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('auth', () => {
  const secret = 'super-secret-jwt-key-for-tests-only-000000';
  const sub = randomUUID();
  const now = Date.now();
  const exp = Math.floor(now / 1000) + 3600;

  it('dev tokens are dev:<uuid>', async () => {
    expect(await devAuth(`dev:${sub}`)).toBe(sub);
    expect(await devAuth('dev:alice')).toBeNull();
    expect(await devAuth(sub)).toBeNull();
  });

  it('Supabase access tokens are verified with the JWT secret (locally signed; not run against real Supabase)', async () => {
    const auth = supabaseAuth(secret, () => now);
    expect(await auth(signHs256({ sub, exp, aud: 'authenticated', role: 'authenticated' }, secret))).toBe(sub);
    expect(await auth(signHs256({ sub, exp, aud: 'authenticated', role: 'authenticated' }, 'wrong-secret'))).toBeNull();
    expect(await auth(signHs256({ sub, exp: Math.floor(now / 1000) - 10, aud: 'authenticated' }, secret))).toBeNull();
    expect(await auth(signHs256({ sub, aud: 'authenticated' }, secret))).toBeNull();
    expect(await auth(signHs256({ sub, exp, role: 'anon', aud: 'authenticated' }, secret))).toBeNull();
    expect(await auth(signHs256({ sub, exp, aud: 'other' }, secret))).toBeNull();
    // Every Supabase user token says `aud: authenticated`; one without an audience is not one.
    expect(await auth(signHs256({ sub, exp, role: 'authenticated' }, secret))).toBeNull();
    expect(await auth(signHs256({ sub: 'not-a-uuid', exp }, secret))).toBeNull();
    // alg=none and tampered payloads are refused.
    const good = signHs256({ sub, exp }, secret).split('.');
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${good[1]}.`;
    expect(await auth(none)).toBeNull();
    const tampered = `${good[0]}.${Buffer.from(JSON.stringify({ sub: randomUUID(), exp })).toString('base64url')}.${good[2]}`;
    expect(await auth(tampered)).toBeNull();
    expect(await auth('garbage')).toBeNull();
  });

  describe('Supabase signing keys via JWKS (locally generated keys, mocked endpoint; not run against real Supabase)', () => {
    const url = 'https://proj.supabase.co';
    const issuer = `${url}/auth/v1`;
    const sign = (alg: 'ES256' | 'RS256' | 'EdDSA', key: KeyObject, kid: string | undefined, payload: Record<string, unknown>) => {
      const h = Buffer.from(JSON.stringify({ alg, typ: 'JWT', ...(kid ? { kid } : {}) })).toString('base64url');
      const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const data = Buffer.from(`${h}.${p}`);
      const sig =
        alg === 'ES256'
          ? cryptoSign('sha256', data, { key, dsaEncoding: 'ieee-p1363' })
          : alg === 'RS256'
            ? cryptoSign('sha256', data, key)
            : cryptoSign(null, data, key);
      return `${h}.${p}.${sig.toString('base64url')}`;
    };
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const ec2 = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const ed = generateKeyPairSync('ed25519');
    const jwk = (k: KeyObject, kid: string, alg: string) => ({ ...k.export({ format: 'jwk' }), kid, alg, use: 'sig' });

    function endpoint(initial: object[]) {
      const state = { keys: initial, calls: 0, fail: false };
      const fetchImpl = async (u: string) => {
        state.calls++;
        expect(u).toBe(`${url}/auth/v1/.well-known/jwks.json`);
        if (state.fail) return { ok: false, status: 503, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ keys: state.keys }) };
      };
      return { state, fetchImpl };
    }

    it('verifies ES256, RS256 and EdDSA tokens and checks the claims', async () => {
      let t = now;
      const ep = endpoint([jwk(ec.publicKey, 'k1', 'ES256'), jwk(rsa.publicKey, 'k2', 'RS256'), jwk(ed.publicKey, 'k3', 'EdDSA')]);
      const auth = jwksAuth({ ...supabaseJwks(url), fetch: ep.fetchImpl, now: () => t });
      const claims = { sub, exp, aud: 'authenticated', role: 'authenticated', iss: issuer };
      expect(await auth(sign('ES256', ec.privateKey, 'k1', claims))).toBe(sub);
      expect(await auth(sign('RS256', rsa.privateKey, 'k2', claims))).toBe(sub);
      expect(await auth(sign('EdDSA', ed.privateKey, 'k3', claims))).toBe(sub);
      // Cached: one fetch for all three.
      expect(ep.state.calls).toBe(1);
      // A key that is not in the set, a wrong issuer, an expired token, anon role, a tampered payload.
      expect(await auth(sign('ES256', ec2.privateKey, 'k1', claims))).toBeNull();
      expect(await auth(sign('ES256', ec.privateKey, 'k1', { ...claims, iss: 'https://evil.example/auth/v1' }))).toBeNull();
      expect(await auth(sign('ES256', ec.privateKey, 'k1', { ...claims, exp: Math.floor(now / 1000) - 5 }))).toBeNull();
      expect(await auth(sign('ES256', ec.privateKey, 'k1', { ...claims, role: 'anon' }))).toBeNull();
      const good = sign('ES256', ec.privateKey, 'k1', claims).split('.');
      expect(await auth(`${good[0]}.${Buffer.from(JSON.stringify({ ...claims, sub: randomUUID() })).toString('base64url')}.${good[2]}`)).toBeNull();
      // An RSA key cannot be used to pass off an ES256 token, nor HS256 via the JWKS path.
      expect(await auth(sign('RS256', rsa.privateKey, 'k1', claims))).toBeNull();
      expect(await auth(signHs256(claims, 'x'))).toBeNull();
      // After the cache expires the set is fetched again.
      t += 11 * 60_000;
      expect(await auth(sign('ES256', ec.privateKey, 'k1', { ...claims, exp: Math.floor(t / 1000) + 60 }))).toBe(sub);
      expect(ep.state.calls).toBe(2);
    });

    it('refetches on an unknown kid (rotation), rate-limited, and survives a failing endpoint', async () => {
      let t = now;
      const errors: unknown[] = [];
      const ep = endpoint([jwk(ec.publicKey, 'old', 'ES256')]);
      const auth = jwksAuth({ ...supabaseJwks(url), fetch: ep.fetchImpl, now: () => t, onError: (e) => errors.push(e) });
      const claims = { sub, exp, aud: 'authenticated', iss: issuer };
      expect(await auth(sign('ES256', ec.privateKey, 'old', claims))).toBe(sub);
      // The issuer is required, not only checked when present.
      expect(await auth(sign('ES256', ec.privateKey, 'old', { sub, exp, aud: 'authenticated' }))).toBeNull();
      ep.state.keys = [jwk(ec.publicKey, 'old', 'ES256'), jwk(ec2.publicKey, 'new', 'ES256')];
      // Within the refetch interval an unknown kid does not trigger a fetch.
      expect(await auth(sign('ES256', ec2.privateKey, 'new', claims))).toBeNull();
      expect(ep.state.calls).toBe(1);
      t += 31_000;
      expect(await auth(sign('ES256', ec2.privateKey, 'new', claims))).toBe(sub);
      expect(ep.state.calls).toBe(2);
      // Endpoint down after expiry: tokens with known keys fail closed, the error is reported.
      ep.state.fail = true;
      t += 11 * 60_000;
      const later = { ...claims, exp: Math.floor(t / 1000) + 60 };
      expect(await auth(sign('ES256', ec.privateKey, 'old', later))).toBe(sub); // old keys are kept on a failed refresh
      await new Promise((r) => setTimeout(r, 0)); // the refresh runs in the background
      expect(errors.length).toBe(1);
      expect(String(errors[0])).toMatch(/503/);
    });

    it('the server accepts HS256 and JWKS tokens side by side when both are configured', async () => {
      const ep = endpoint([jwk(ec.publicKey, 'k1', 'ES256')]);
      const auth = combinedSupabaseAuth({ secret, supabaseUrl: url, fetch: ep.fetchImpl, now: () => now });
      const claims = { sub, exp, aud: 'authenticated', iss: issuer };
      expect(await auth(signHs256(claims, secret))).toBe(sub);
      expect(await auth(sign('ES256', ec.privateKey, 'k1', claims))).toBe(sub);
      // The HS256 path checks the issuer too once the project URL is known.
      expect(await auth(signHs256({ ...claims, iss: 'https://other.supabase.co/auth/v1' }, secret))).toBeNull();
      expect(await auth(signHs256({ sub, exp, aud: 'authenticated' }, secret))).toBeNull();
      const hsOnly = combinedSupabaseAuth({ secret, now: () => now });
      expect(await hsOnly(sign('ES256', ec.privateKey, 'k1', claims))).toBeNull();
      expect(await hsOnly(signHs256({ sub, exp, aud: 'authenticated' }, secret))).toBe(sub);
      expect(ep.state.calls).toBe(1);
    });

    it('a JWKS endpoint that hangs times out, answers "could not verify" (not "rejected"), and never holds requests once keys are cached', async () => {
      let t = now;
      const claims = { sub, exp: Math.floor(now / 1000) + 7200, aud: 'authenticated', iss: issuer };
      let hang = true;
      let calls = 0;
      const fetchImpl = (async () => {
        calls++;
        if (hang) return new Promise(() => {});
        return { ok: true, status: 200, json: async () => ({ keys: [jwk(ec.publicKey, 'k1', 'ES256')] }) };
      }) as never;
      const auth = jwksAuth({ ...supabaseJwks(url), fetch: fetchImpl, now: () => t, fetchTimeoutMs: 50 });
      const started = Date.now();
      await expect(auth(sign('ES256', ec.privateKey, 'k1', claims))).rejects.toBeInstanceOf(AuthUnavailableError);
      expect(Date.now() - started).toBeLessThan(2000);
      // Within the back-off the endpoint is not asked again; the answer is still "could not verify".
      await expect(auth(sign('ES256', ec.privateKey, 'k1', claims))).rejects.toBeInstanceOf(AuthUnavailableError);
      expect(calls).toBe(1);
      hang = false;
      t += 31_000;
      expect(await auth(sign('ES256', ec.privateKey, 'k1', claims))).toBe(sub);
      // Cache expired and the endpoint hangs again: requests are answered at once with the cached keys.
      hang = true;
      t += 11 * 60_000;
      const t0 = Date.now();
      expect(await auth(sign('ES256', ec.privateKey, 'k1', claims))).toBe(sub);
      expect(Date.now() - t0).toBeLessThan(40);
    });

    it('the API answers 503 auth_unavailable when the token could not be checked, 401 when it was rejected', async () => {
      const app = createApp({
        db: null as never,
        storage: null as never,
        queue: { send: async () => {} },
        log: memoryLogger(),
        authenticate: async (token) => {
          if (token === 'down') throw new AuthUnavailableError();
          return null;
        },
      });
      const down = await app.fetch(new Request('http://x/v1/goal', { headers: { authorization: 'Bearer down' } }));
      expect(down.status).toBe(503);
      expect(((await down.json()) as { error: { code: string } }).error.code).toBe('auth_unavailable');
      const bad = await app.fetch(new Request('http://x/v1/goal', { headers: { authorization: 'Bearer bad' } }));
      expect(bad.status).toBe(401);
    });
  });

  it('dev auth refuses to start in production', () => {
    const prod = loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x/y', KILO_AUTH: 'dev' });
    expect(() => assertConfig(prod, { api: true, worker: false })).toThrow(/not allowed/);
    expect(() => authenticatorFor(prod)).toThrow(/not allowed/);
    const supa = loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x/y', KILO_AUTH: 'supabase' });
    expect(() => assertConfig(supa, { api: true, worker: false })).toThrow(/SUPABASE_JWT_SECRET/);
    const signing = randomBytes(24).toString('hex');
    const jwksOnly = loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x/y', KILO_AUTH: 'supabase', SUPABASE_URL: 'https://p.supabase.co', KILO_LOCAL_SIGNING_SECRET: signing });
    expect(() => assertConfig(jwksOnly, { api: true, worker: false })).not.toThrow();
    const ok = loadConfig({
      NODE_ENV: 'production', DATABASE_URL: 'postgres://x/y', KILO_AUTH: 'supabase', SUPABASE_JWT_SECRET: 's',
      KILO_LOCAL_SIGNING_SECRET: randomBytes(24).toString('hex'),
    });
    expect(() => assertConfig(ok, { api: true, worker: true })).not.toThrow();
    expect(() => loadConfig({ KILO_AUTH: 'dev', KILO_STORAGE: 'ftp' })).toThrow(/KILO_STORAGE/);
    // KILO_AUTH has no default: forgetting it must not mean dev tokens are accepted.
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x/y' })).toThrow(/KILO_AUTH must be set/);
    // Production with local storage needs a signing secret chosen on purpose, not the generated file or a placeholder.
    const prodLocal = (extra: Record<string, string>) =>
      loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x/y', KILO_AUTH: 'supabase', SUPABASE_JWT_SECRET: 's', ...extra });
    expect(() => assertConfig(prodLocal({}), { api: true, worker: true })).toThrow(/KILO_LOCAL_SIGNING_SECRET/);
    expect(() => assertConfig(prodLocal({ KILO_LOCAL_SIGNING_SECRET: 'changeme' }), { api: true, worker: true })).toThrow(/KILO_LOCAL_SIGNING_SECRET/);
    expect(() => assertConfig(prodLocal({ KILO_STORAGE: 'supabase', SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' }), { api: true, worker: true })).not.toThrow();
    const storage = loadConfig({ DATABASE_URL: 'postgres://x/y', KILO_AUTH: 'dev', KILO_STORAGE: 'supabase' });
    expect(() => assertConfig(storage, { api: false, worker: true })).toThrow(/SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY/);
  });
});

describe('provider check at startup', () => {
  const report = (standIns: string[]) => ({ standIns, summary: `transcriber=x, decider=y (${standIns.join(',')})` });
  const prod = loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x/y', KILO_AUTH: 'supabase', SUPABASE_JWT_SECRET: 's' });
  const allowed = loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x/y', KILO_AUTH: 'supabase', SUPABASE_JWT_SECRET: 's', KILO_ALLOW_STAND_INS: '1' });
  const dev = loadConfig({ DATABASE_URL: 'postgres://x/y', KILO_AUTH: 'dev' });

  it('a production worker refuses an offline transcriber or decider unless KILO_ALLOW_STAND_INS=1', () => {
    expect(() => assertProviders(prod, report(['transcriber', 'decider', 'describer', 'stock']), { worker: true })).toThrow(/transcriber and decider must be a real service/);
    expect(() => assertProviders(prod, report(['decider']), { worker: true })).toThrow(/decider must be a real service/);
    // Describer and stock search may be stand-ins; the API alone does not run the pipeline.
    expect(() => assertProviders(prod, report(['describer', 'stock']), { worker: true })).not.toThrow();
    expect(() => assertProviders(prod, report(['transcriber']), { worker: false })).not.toThrow();
    // A pipeline that cannot say (the fake one) is refused too.
    expect(() => assertProviders(prod, null, { worker: true })).toThrow(/KILO_ALLOW_STAND_INS/);
    expect(() => assertProviders(allowed, report(['transcriber', 'decider']), { worker: true })).not.toThrow();
    expect(() => assertProviders(dev, report(['transcriber', 'decider']), { worker: true })).not.toThrow();
  });

  it('the real pipeline reports its providers without keys', async () => {
    const { analyze, describeProviders } = await import('@kilo/analyze');
    expect(analyze.describeProviders().summary).toMatch(/transcriber=/);
    const r = describeProviders({ ANTHROPIC_API_KEY: 'sk-ant-secret-1', KILO_TRANSCRIBER: 'deepgram', DEEPGRAM_API_KEY: 'dg-secret-2' });
    expect(r.standIns).not.toContain('transcriber');
    expect(r.standIns).not.toContain('decider');
    expect(JSON.stringify(r)).not.toMatch(/secret-1|secret-2/);
  });
});

describe('push providers', () => {
  it('Expo: posts messages in chunks of 100 and reports unregistered devices (mocked; not run against Expo)', async () => {
    const bodies: { headers: Record<string, string>; messages: { to: string; data: unknown; title: string }[] }[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const messages = JSON.parse(String(init.body)) as { to: string; data: unknown; title: string }[];
      bodies.push({ headers: init.headers as Record<string, string>, messages });
      return Response.json({
        data: messages.map((m) =>
          m.to.endsWith('[dead]') ? { status: 'error', details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: 'x' },
        ),
      });
    }) as unknown as typeof fetch;
    const tokens = [...Array.from({ length: 150 }, (_, i) => `ExponentPushToken[${i}]`), 'ExponentPushToken[dead]'];
    const push = new ExpoPush('expo-token', fetchImpl);
    const result = await push.send(tokens, { title: 'T', body: 'B', data: { type: 'render_done', videoId: 'v', renderId: 'r' } });
    expect(bodies.map((b) => b.messages.length)).toEqual([100, 51]);
    expect(bodies[0]!.headers.authorization).toBe('Bearer expo-token');
    expect(bodies[0]!.messages[0]!.data).toEqual({ type: 'render_done', videoId: 'v', renderId: 'r' });
    expect(result.invalidTokens).toEqual(['ExponentPushToken[dead]']);
    const noToken = new ExpoPush(undefined, fetchImpl);
    await noToken.send(['ExponentPushToken[1]'], { title: 'T', body: 'B', data: { type: 'goal_reminder' } });
    expect(bodies[2]!.headers.authorization).toBeUndefined();
    const failing = new ExpoPush(undefined, (async () => new Response('down', { status: 503 })) as unknown as typeof fetch);
    await expect(failing.send(['x'], { title: 'T', body: 'B', data: { type: 'goal_reminder' } })).rejects.toThrow(/503/);
  });

  it('log provider records what would have been sent', async () => {
    const log = memoryLogger();
    const push = new LogPush(log);
    await push.send([], { title: 'T', body: 'B', data: { type: 'batch_ready', batchId: 'b' } });
    expect(push.sent).toHaveLength(1);
    expect(log.lines[0]!.fields).toMatchObject({ provider: 'log', type: 'batch_ready', devices: 0 });
  });
});
