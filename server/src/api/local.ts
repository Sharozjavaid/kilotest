import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { HttpError } from '../errors.js';
import { UploadTooLargeError, type LocalStorage } from '../storage/local.js';
import { DEFAULT_MAX_UPLOAD_BYTES } from '../uploads.js';
import { contentTypeFor } from '../storage/types.js';

const badToken = () => new HttpError(401, 'unauthorized', 'This link is invalid or has expired');

/** Parses a single `bytes=` range. Returns null for a header we ignore, 'invalid' for one we cannot satisfy. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // Multiple ranges or another unit: serve the whole file.
  const [, a, b] = m;
  if (a === '' && b === '') return 'invalid';
  let start: number;
  let end: number;
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

/** Upload and download endpoints for the local storage driver's signed tokens. */
export function localRoutes(storage: LocalStorage, maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES): Hono {
  const app = new Hono();

  app.put('/upload/:token', async (c) => {
    const token = storage.verifyToken(c.req.param('token'), 'put');
    if (!token) throw badToken();
    const limit = Math.min(token.max ?? maxUploadBytes, maxUploadBytes);
    const tooLarge = () => new HttpError(413, 'file_too_large', `This file is larger than the ${limit} bytes declared for it`);
    const declaredLength = Number(c.req.header('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > limit) throw tooLarge();
    const body = c.req.raw.body;
    if (!body) throw new HttpError(400, 'invalid_request', 'Empty body');
    try {
      await storage.writeStream(token.key, body, limit);
    } catch (err) {
      if (err instanceof UploadTooLargeError) throw tooLarge();
      throw err;
    }
    return c.body(null, 204);
  });

  const serve = async (token: string, rangeHeader: string | undefined, head: boolean) => {
    const key = storage.verify(token, 'get');
    if (!key) throw badToken();
    const size = await storage.size(key);
    if (size === null) throw new HttpError(404, 'not_found', 'File not found');
    const headers: Record<string, string> = {
      'content-type': contentTypeFor(key),
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=300',
    };
    const range = parseRange(rangeHeader, size);
    if (range === 'invalid') {
      return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } });
    }
    const status = range ? 206 : 200;
    const { start, end } = range ?? { start: 0, end: size - 1 };
    headers['content-length'] = String(size === 0 ? 0 : end - start + 1);
    if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`;
    if (head || size === 0) return new Response(null, { status, headers });
    const stream = Readable.toWeb(storage.createReadStream(key, { start, end })) as ReadableStream;
    return new Response(stream, { status, headers });
  };

  app.get('/file/:token', (c) => serve(c.req.param('token'), c.req.header('range'), false));
  app.on('HEAD', '/file/:token', (c) => serve(c.req.param('token'), c.req.header('range'), true));

  return app;
}
