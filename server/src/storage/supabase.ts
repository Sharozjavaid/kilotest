import { createWriteStream } from 'node:fs';
import { mkdir, open, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { UploadTarget } from '@kilo/edl';
import { assertSafeKey, type StorageDriver } from './types.js';

type Fetch = typeof fetch;

/** Supabase rejects resumable chunks of any other size except the last. */
export const TUS_CHUNK = 6 * 1024 * 1024;

const encodeKey = (key: string) => key.split('/').map(encodeURIComponent).join('/');
const b64 = (s: string) => Buffer.from(s).toString('base64');

/**
 * Supabase Storage through its REST and tus endpoints, authenticated with the
 * service role key. The app never sees that key: it gets a signed upload token
 * that the storage API accepts in the `x-signature` header of a tus upload.
 *
 * Not yet exercised against a real Supabase project; covered by tests against a
 * mocked fetch only.
 */
export class SupabaseStorage implements StorageDriver {
  readonly kind = 'supabase' as const;
  private readonly base: string;

  constructor(
    supabaseUrl: string,
    private readonly serviceKey: string,
    readonly bucket: string,
    private readonly options: { anonKey?: string; defaultTtlSec?: number; fetch?: Fetch } = {},
  ) {
    this.base = `${supabaseUrl.replace(/\/+$/, '')}/storage/v1`;
  }

  private get fetch(): Fetch {
    return this.options.fetch ?? fetch;
  }

  private auth(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.serviceKey}`, apikey: this.serviceKey, ...extra };
  }

  private async call(path: string, init: RequestInit & { okStatuses?: number[] } = {}): Promise<Response> {
    const res = await this.fetch(`${this.base}${path}`, init);
    if (!res.ok && !(init.okStatuses ?? []).includes(res.status)) {
      const text = await res.text().catch(() => '');
      throw new Error(`Supabase storage ${init.method ?? 'GET'} ${path.split('?')[0]} failed: ${res.status} ${text.slice(0, 200)}`);
    }
    return res;
  }

  /** Supabase cannot cap a signed tus upload; the size is checked when the upload is completed. */
  async createUploadTarget(key: string, contentType: string, _opts?: { maxBytes?: number }): Promise<UploadTarget> {
    assertSafeKey(key);
    const res = await this.call(`/object/upload/sign/${this.bucket}/${encodeKey(key)}`, {
      method: 'POST',
      headers: this.auth({ 'content-type': 'application/json', 'x-upsert': 'true' }),
      body: '{}',
    });
    const body = (await res.json()) as { url?: string; token?: string };
    const token = body.token ?? (body.url ? new URL(body.url, 'http://x').searchParams.get('token') : null);
    if (!token) throw new Error('Supabase storage returned no upload token');
    const headers: Record<string, string> = {
      'x-signature': token,
      'x-upsert': 'true',
      'content-type': contentType,
    };
    if (this.options.anonKey) headers.apikey = this.options.anonKey;
    return { kind: 'tus', url: `${this.base}/upload/resumable/sign`, headers, objectKey: key, bucket: this.bucket };
  }

  async signedUrl(key: string, ttlSec = this.options.defaultTtlSec ?? 3600): Promise<string> {
    assertSafeKey(key);
    const res = await this.call(`/object/sign/${this.bucket}/${encodeKey(key)}`, {
      method: 'POST',
      headers: this.auth({ 'content-type': 'application/json' }),
      body: JSON.stringify({ expiresIn: ttlSec }),
    });
    const body = (await res.json()) as { signedURL?: string; signedUrl?: string };
    const path = body.signedURL ?? body.signedUrl;
    if (!path) throw new Error('Supabase storage returned no signed URL');
    return path.startsWith('http') ? path : `${this.base}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  async exists(key: string): Promise<boolean> {
    assertSafeKey(key);
    const res = await this.call(`/object/authenticated/${this.bucket}/${encodeKey(key)}`, {
      method: 'HEAD',
      headers: this.auth(),
      okStatuses: [400, 404],
    });
    return res.ok;
  }

  async size(key: string): Promise<number | null> {
    assertSafeKey(key);
    const res = await this.call(`/object/authenticated/${this.bucket}/${encodeKey(key)}`, {
      method: 'HEAD',
      headers: this.auth(),
      okStatuses: [400, 404],
    });
    if (!res.ok) return null;
    const n = Number(res.headers.get('content-length'));
    return Number.isFinite(n) && res.headers.has('content-length') ? n : null;
  }

  async download(key: string, destPath: string): Promise<void> {
    assertSafeKey(key);
    const res = await this.call(`/object/authenticated/${this.bucket}/${encodeKey(key)}`, { headers: this.auth() });
    if (!res.body) throw new Error('Supabase storage returned an empty body');
    await mkdir(dirname(destPath), { recursive: true });
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(destPath));
  }

  async upload(key: string, srcPath: string, contentType: string): Promise<void> {
    assertSafeKey(key);
    const size = (await stat(srcPath)).size;
    if (size <= TUS_CHUNK) {
      const handle = await open(srcPath, 'r');
      try {
        const data = await handle.readFile();
        await this.call(`/object/${this.bucket}/${encodeKey(key)}`, {
          method: 'POST',
          headers: this.auth({ 'content-type': contentType, 'x-upsert': 'true' }),
          body: data,
        });
      } finally {
        await handle.close();
      }
      return;
    }
    await this.tusUpload(key, srcPath, size, contentType);
  }

  /** Server-side resumable upload in 6 MB chunks, for files too big for one request. */
  private async tusUpload(key: string, srcPath: string, size: number, contentType: string): Promise<void> {
    const metadata = [
      `bucketName ${b64(this.bucket)}`,
      `objectName ${b64(key)}`,
      `contentType ${b64(contentType)}`,
      `cacheControl ${b64('3600')}`,
    ].join(',');
    const created = await this.call('/upload/resumable', {
      method: 'POST',
      headers: this.auth({
        'tus-resumable': '1.0.0',
        'upload-length': String(size),
        'upload-metadata': metadata,
        'x-upsert': 'true',
      }),
    });
    const location = created.headers.get('location');
    if (!location) throw new Error('Supabase storage returned no upload location');
    const uploadUrl = location.startsWith('http') ? location : new URL(location, this.base + '/').toString();
    const handle = await open(srcPath, 'r');
    try {
      let offset = 0;
      while (offset < size) {
        const length = Math.min(TUS_CHUNK, size - offset);
        const chunk = Buffer.alloc(length);
        await handle.read(chunk, 0, length, offset);
        const res = await this.fetch(uploadUrl, {
          method: 'PATCH',
          headers: this.auth({
            'tus-resumable': '1.0.0',
            'upload-offset': String(offset),
            'content-type': 'application/offset+octet-stream',
          }),
          body: chunk,
        });
        if (!res.ok) throw new Error(`Supabase resumable upload failed at ${offset}: ${res.status}`);
        const next = Number(res.headers.get('upload-offset'));
        offset = Number.isFinite(next) && next > offset ? next : offset + length;
      }
    } finally {
      await handle.close();
    }
  }

  async deleteKeys(keys: string[]): Promise<void> {
    if (!keys.length) return;
    keys.forEach(assertSafeKey);
    for (let i = 0; i < keys.length; i += 1000) {
      await this.call(`/object/${this.bucket}`, {
        method: 'DELETE',
        headers: this.auth({ 'content-type': 'application/json' }),
        body: JSON.stringify({ prefixes: keys.slice(i, i + 1000) }),
      });
    }
  }

  /** One page-through of a folder: its sub-folders and objects (with their times). */
  private async listFolder(folder: string): Promise<{ folders: string[]; objects: { path: string; at: Date | null }[] }> {
    const folders: string[] = [];
    const objects: { path: string; at: Date | null }[] = [];
    for (let offset = 0; ; offset += 1000) {
      const res = await this.call(`/object/list/${this.bucket}`, {
        method: 'POST',
        headers: this.auth({ 'content-type': 'application/json' }),
        body: JSON.stringify({ prefix: folder, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }),
      });
      const items = (await res.json()) as { name: string; id: string | null; updated_at?: string | null; created_at?: string | null }[];
      for (const item of items) {
        const path = folder ? `${folder}/${item.name}` : item.name;
        if (item.id === null) folders.push(path);
        else {
          const t = item.updated_at ?? item.created_at;
          objects.push({ path, at: t ? new Date(t) : null });
        }
      }
      if (items.length < 1000) break;
    }
    return { folders, objects };
  }

  private async walk(folder: string): Promise<{ path: string; at: Date | null }[]> {
    const { folders, objects } = await this.listFolder(folder);
    for (const f of folders) objects.push(...(await this.walk(f)));
    return objects;
  }

  async deletePrefix(prefix: string): Promise<void> {
    assertSafeKey(prefix);
    const all = await this.walk(prefix);
    await this.deleteKeys(all.map((o) => o.path));
  }

  /** Not yet exercised against a real Supabase project; tested against a mocked storage API. */
  async listVideoPrefixes(): Promise<{ userId: string; videoId: string; newest: Date | null }[]> {
    const out: { userId: string; videoId: string; newest: Date | null }[] = [];
    for (const userFolder of (await this.listFolder('users')).folders) {
      const userId = userFolder.split('/')[1]!;
      for (const videoFolder of (await this.listFolder(`${userFolder}/videos`)).folders) {
        const videoId = videoFolder.split('/').pop()!;
        const objects = await this.walk(videoFolder);
        const times = objects.map((o) => o.at?.getTime() ?? NaN).filter((t) => Number.isFinite(t));
        // An object without a time counts as new: the sweep must never remove what it cannot date.
        const newest = objects.some((o) => !o.at) ? new Date() : times.length ? new Date(Math.max(...times)) : null;
        out.push({ userId, videoId, newest });
      }
    }
    return out;
  }
}
