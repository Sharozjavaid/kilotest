import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { memoryLogger } from '../src/log.js';
import type { JobQueue } from '../src/queue.js';
import { LocalStorage } from '../src/storage/local.js';
import { SERVER_DIR } from './helpers.js';

/** The web app calls the API, PUTs to upload targets and plays files from another origin. */
describe('CORS', () => {
  let dir: string;
  let storage: LocalStorage;
  const queue: JobQueue = { send: async () => {} };
  const app = (corsOrigins?: string[]) =>
    createApp({ db: null as never, storage, queue, authenticate: async () => null, log: memoryLogger(), corsOrigins });

  beforeAll(async () => {
    dir = await mkdtemp(join(SERVER_DIR, '.work', 'cors-'));
    storage = new LocalStorage(dir, 'kilo', 'http://api.test', 'secret');
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('answers preflights without auth, for the API and the upload route', async () => {
    for (const path of ['/v1/home', '/v1/videos/x/edl', '/v1/local/upload/token']) {
      const res = await app().request(path, {
        method: 'OPTIONS',
        headers: { origin: 'http://localhost:8081', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization,content-type' },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(res.headers.get('access-control-allow-methods')).toContain('PUT');
      expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
    }
  });

  it('puts the headers on errors and on file responses, exposing Range headers', async () => {
    const unauth = await app().request('/v1/home', { headers: { origin: 'http://localhost:8081' } });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get('access-control-allow-origin')).toBe('*');
    await storage.writeStream('users/u/a.mp4', new Blob([new Uint8Array(100)]).stream());
    const url = new URL(await storage.signedUrl('users/u/a.mp4'));
    const file = await app().request(url.pathname, { headers: { origin: 'http://localhost:8081', range: 'bytes=0-9' } });
    expect(file.status).toBe(206);
    expect(file.headers.get('access-control-allow-origin')).toBe('*');
    expect(file.headers.get('access-control-expose-headers')).toContain('content-range');
  });

  it('allows only the configured origins when KILO_CORS_ORIGINS is set', async () => {
    const a = app(['https://app.kilo.test']);
    const ok = await a.request('/v1/health', { headers: { origin: 'https://app.kilo.test' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://app.kilo.test');
    const other = await a.request('/v1/health', { headers: { origin: 'https://evil.test' } });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });
});
