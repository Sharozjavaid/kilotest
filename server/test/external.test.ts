import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UploadTarget } from '@kilo/edl';
import { devAuth, signHs256, supabaseAuth } from '../src/auth.js';
import { assertConfig, loadConfig } from '../src/config.js';
import { memoryLogger } from '../src/log.js';
import { ExpoPush, LogPush } from '../src/push.js';
import { authenticatorFor } from '../src/server.js';
import { SupabaseStorage, TUS_CHUNK } from '../src/storage/supabase.js';
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
      return new Response(method === 'HEAD' ? null : new Uint8Array(obj), { status: 200 });
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
    const bigKey = 'users/u1/videos/v1/renders/r1.mp4';
    await storage.upload(bigKey, large, 'video/mp4');
    expect(fake.requests.filter((r) => r.method === 'PATCH')).toHaveLength(3);
    expect(fake.objects.get(bigKey)!.equals(largeBytes)).toBe(true);
    const back = join(dir, 'back.bin');
    await storage.download(bigKey, back);
    expect((await readFile(back)).equals(largeBytes)).toBe(true);
    fake.objects.set('users/u1/videos/v1/clips/c2/thumb.jpg', Buffer.from('x'));
    fake.objects.set('users/u2/videos/v9/proxy.mp4', Buffer.from('x'));
    await storage.deletePrefix('users/u1/videos/v1');
    expect([...fake.objects.keys()]).toEqual(['users/u2/videos/v9/proxy.mp4']);
    await expect(storage.download('users/u1/missing.mp4', back)).rejects.toThrow(/400/);
    await expect(storage.signedUrl('../etc/passwd')).rejects.toThrow(/Unsafe/);
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
    expect(await auth(signHs256({ sub: 'not-a-uuid', exp }, secret))).toBeNull();
    // alg=none and tampered payloads are refused.
    const good = signHs256({ sub, exp }, secret).split('.');
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${good[1]}.`;
    expect(await auth(none)).toBeNull();
    const tampered = `${good[0]}.${Buffer.from(JSON.stringify({ sub: randomUUID(), exp })).toString('base64url')}.${good[2]}`;
    expect(await auth(tampered)).toBeNull();
    expect(await auth('garbage')).toBeNull();
  });

  it('dev auth refuses to start in production', () => {
    const prod = loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x/y', KILO_AUTH: 'dev' });
    expect(() => assertConfig(prod, { api: true, worker: false })).toThrow(/not allowed/);
    expect(() => authenticatorFor(prod)).toThrow(/not allowed/);
    const supa = loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x/y', KILO_AUTH: 'supabase' });
    expect(() => assertConfig(supa, { api: true, worker: false })).toThrow(/SUPABASE_JWT_SECRET/);
    const ok = loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x/y', KILO_AUTH: 'supabase', SUPABASE_JWT_SECRET: 's' });
    expect(() => assertConfig(ok, { api: true, worker: true })).not.toThrow();
    expect(() => loadConfig({ KILO_STORAGE: 'ftp' })).toThrow(/KILO_STORAGE/);
    const storage = loadConfig({ DATABASE_URL: 'postgres://x/y', KILO_STORAGE: 'supabase' });
    expect(() => assertConfig(storage, { api: false, worker: true })).toThrow(/SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY/);
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
