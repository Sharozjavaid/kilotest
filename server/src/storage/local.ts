import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { UploadTarget } from '@kilo/edl';
import { assertSafeKey, type StorageDriver } from './types.js';

interface TokenBody {
  /** 'put' upload target or 'get' download. */
  op: 'put' | 'get';
  key: string;
  /** Expiry, unix seconds. */
  exp: number;
  /** Upload targets: the most bytes the upload may carry. */
  max?: number;
}

/** The upload carried more bytes than its target allows. */
export class UploadTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`The upload is larger than the ${limit} bytes allowed`);
  }
}

/** Upload URLs stay valid for a day so a slow mobile upload can finish. */
const UPLOAD_TTL_SEC = 24 * 3600;

/**
 * Files under `root/<bucket>/<key>`. Upload targets and downloads are HMAC-signed,
 * expiring tokens served by the `/v1/local/...` routes.
 */
export class LocalStorage implements StorageDriver {
  readonly kind = 'local' as const;

  constructor(
    private readonly root: string,
    readonly bucket: string,
    private readonly publicUrl: string,
    private readonly secret: string,
    private readonly defaultTtlSec = 3600,
    private readonly now: () => number = () => Date.now(),
  ) {}

  pathOf(key: string): string {
    assertSafeKey(key);
    return join(this.root, this.bucket, key);
  }

  sign(body: TokenBody): string {
    const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
    const mac = createHmac('sha256', this.secret).update(payload).digest('base64url');
    return `${payload}.${mac}`;
  }

  /** Returns the key a token grants, or null when it is forged, expired or for another operation. */
  verify(token: string, op: TokenBody['op']): string | null {
    return this.verifyToken(token, op)?.key ?? null;
  }

  /** The whole token body, or null when it is not acceptable. */
  verifyToken(token: string, op: TokenBody['op']): TokenBody | null {
    const [payload, mac] = token.split('.');
    if (!payload || !mac) return null;
    const expected = createHmac('sha256', this.secret).update(payload).digest();
    const given = Buffer.from(mac, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TokenBody;
      if (body.op !== op || typeof body.key !== 'string') return null;
      if (body.exp * 1000 < this.now()) return null;
      assertSafeKey(body.key);
      return body;
    } catch {
      return null;
    }
  }

  async createUploadTarget(key: string, contentType: string, opts: { maxBytes?: number } = {}): Promise<UploadTarget> {
    assertSafeKey(key);
    const body: TokenBody = { op: 'put', key, exp: Math.floor(this.now() / 1000) + UPLOAD_TTL_SEC };
    if (opts.maxBytes !== undefined) body.max = Math.floor(opts.maxBytes);
    const token = this.sign(body);
    return {
      kind: 'put',
      url: `${this.publicUrl}/v1/local/upload/${token}`,
      headers: { 'content-type': contentType },
      objectKey: key,
      bucket: this.bucket,
    };
  }

  async signedUrl(key: string, ttlSec = this.defaultTtlSec): Promise<string> {
    const token = this.sign({ op: 'get', key, exp: Math.floor(this.now() / 1000) + ttlSec });
    return `${this.publicUrl}/v1/local/file/${token}`;
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await stat(this.pathOf(key))).isFile();
    } catch {
      return false;
    }
  }

  async download(key: string, destPath: string): Promise<void> {
    await mkdir(dirname(destPath), { recursive: true });
    await copyFile(this.pathOf(key), destPath);
  }

  async upload(key: string, srcPath: string): Promise<void> {
    const dest = this.pathOf(key);
    await mkdir(dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.${Date.now()}.part`;
    await copyFile(srcPath, tmp);
    await rename(tmp, dest);
  }

  /**
   * Writes a request body stream to `key` atomically. With `maxBytes`, stops and
   * throws UploadTooLargeError as soon as more than that arrives (nothing is kept).
   */
  async writeStream(key: string, body: Readable | ReadableStream<Uint8Array>, maxBytes?: number): Promise<number> {
    const dest = this.pathOf(key);
    await mkdir(dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.${Date.now()}.part`;
    const src = body instanceof Readable ? body : Readable.fromWeb(body as import('node:stream/web').ReadableStream);
    let seen = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        seen += chunk.length;
        if (maxBytes !== undefined && seen > maxBytes) cb(new UploadTooLargeError(maxBytes));
        else cb(null, chunk);
      },
    });
    try {
      await pipeline(src, limit, createWriteStream(tmp));
      await rename(tmp, dest);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    return (await stat(dest)).size;
  }

  createReadStream(key: string, range?: { start: number; end: number }) {
    return createReadStream(this.pathOf(key), range);
  }

  async size(key: string): Promise<number | null> {
    try {
      const s = await stat(this.pathOf(key));
      return s.isFile() ? s.size : null;
    } catch {
      return null;
    }
  }

  async deleteKeys(keys: string[]): Promise<void> {
    await Promise.all(keys.map((k) => rm(this.pathOf(k), { force: true })));
  }

  async deletePrefix(prefix: string): Promise<void> {
    await rm(this.pathOf(prefix), { recursive: true, force: true });
  }
}
