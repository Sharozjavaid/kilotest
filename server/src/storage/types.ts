import type { UploadTarget } from '@kilo/edl';

/** One bucket of objects addressed by storage key (see CONTRACTS.md section 5). */
export interface StorageDriver {
  readonly kind: 'local' | 'supabase';
  readonly bucket: string;
  /** Where the app sends a new file's bytes. */
  createUploadTarget(key: string, contentType: string): Promise<UploadTarget>;
  /** A URL anyone can GET for `ttlSec` seconds. */
  signedUrl(key: string, ttlSec?: number): Promise<string>;
  exists(key: string): Promise<boolean>;
  /** Copies an object to a local file. */
  download(key: string, destPath: string): Promise<void>;
  /** Stores a local file under `key`, replacing any object there. */
  upload(key: string, srcPath: string, contentType: string): Promise<void>;
  deleteKeys(keys: string[]): Promise<void>;
  /** Removes every object whose key starts with `prefix/`. */
  deletePrefix(prefix: string): Promise<void>;
}

const EXT_BY_TYPE: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-m4v': 'm4v',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

const TYPE_BY_EXT: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  wav: 'audio/wav',
  json: 'application/json',
};

/** File extension for a storage key: from the file name when sane, else the content type. */
export function extensionFor(filename: string, contentType: string): string {
  const fromName = /\.([A-Za-z0-9]{1,5})$/.exec(filename)?.[1]?.toLowerCase();
  if (fromName) return fromName === 'jpeg' ? 'jpg' : fromName;
  return EXT_BY_TYPE[contentType.toLowerCase().split(';')[0]!.trim()] ?? 'bin';
}

export function contentTypeFor(key: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(key)?.[1]?.toLowerCase() ?? '';
  return TYPE_BY_EXT[ext] ?? 'application/octet-stream';
}

/** Storage keys, exactly as in CONTRACTS.md. */
export const keys = {
  video: (userId: string, videoId: string) => `users/${userId}/videos/${videoId}`,
  clipSource: (u: string, v: string, clipId: string, ext: string) => `users/${u}/videos/${v}/clips/${clipId}/source.${ext}`,
  clipNormalized: (u: string, v: string, clipId: string) => `users/${u}/videos/${v}/clips/${clipId}/normalized.mp4`,
  clipThumb: (u: string, v: string, clipId: string) => `users/${u}/videos/${v}/clips/${clipId}/thumb.jpg`,
  proxy: (u: string, v: string) => `users/${u}/videos/${v}/proxy.mp4`,
  brollSource: (u: string, v: string, assetId: string, ext: string) => `users/${u}/videos/${v}/broll/${assetId}/source.${ext}`,
  brollNormalized: (u: string, v: string, assetId: string, ext: string) =>
    `users/${u}/videos/${v}/broll/${assetId}/normalized.${ext}`,
  brollThumb: (u: string, v: string, assetId: string) => `users/${u}/videos/${v}/broll/${assetId}/thumb.jpg`,
  brollPrefix: (u: string, v: string, assetId: string) => `users/${u}/videos/${v}/broll/${assetId}`,
  render: (u: string, v: string, renderId: string) => `users/${u}/videos/${v}/renders/${renderId}.mp4`,
};

/** Rejects keys that could escape the bucket. */
export function assertSafeKey(key: string): void {
  if (!key || key.startsWith('/') || key.split('/').some((p) => p === '' || p === '.' || p === '..') || key.includes('\\')) {
    throw new Error(`Unsafe storage key: ${key}`);
  }
}
