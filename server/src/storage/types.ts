import type { UploadTarget } from '@kilo/edl';

/** One bucket of objects addressed by storage key (see CONTRACTS.md section 5). */
export interface StorageDriver {
  readonly kind: 'local' | 'supabase';
  readonly bucket: string;
  /**
   * Where the app sends a new file's bytes. `maxBytes` is the most the upload may
   * carry; drivers that can enforce it while the bytes arrive do so.
   */
  createUploadTarget(key: string, contentType: string, opts?: { maxBytes?: number }): Promise<UploadTarget>;
  /** A URL anyone can GET for `ttlSec` seconds. */
  signedUrl(key: string, ttlSec?: number): Promise<string>;
  exists(key: string): Promise<boolean>;
  /** Size in bytes of a stored object, or null when it does not exist (or the size is unknown). */
  size(key: string): Promise<number | null>;
  /** Copies an object to a local file. */
  download(key: string, destPath: string): Promise<void>;
  /** Stores a local file under `key`, replacing any object there. */
  upload(key: string, srcPath: string, contentType: string): Promise<void>;
  deleteKeys(keys: string[]): Promise<void>;
  /** Removes every object whose key starts with `prefix/`. */
  deletePrefix(prefix: string): Promise<void>;
  /**
   * Every `users/<userId>/videos/<videoId>` prefix in the bucket, with the time of its
   * newest object (null when unknown), for the orphan sweep.
   */
  listVideoPrefixes(): Promise<{ userId: string; videoId: string; newest: Date | null }[]>;
}

const EXT_BY_TYPE: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-m4v': 'm4v',
  'video/x-matroska': 'mkv',
  'video/3gpp': '3gp',
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
  mkv: 'video/x-matroska',
  '3gp': 'video/3gpp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  wav: 'audio/wav',
  json: 'application/json',
};

/** Containers a clip may come in. The pipeline also checks the bytes; this only keeps storage keys sane. */
export const CLIP_EXTENSIONS: readonly string[] = ['mp4', 'mov', 'm4v', 'webm', 'mkv', '3gp'];
/** B-roll may also be a still. */
export const BROLL_EXTENSIONS: readonly string[] = [...CLIP_EXTENSIONS, 'jpg', 'jpeg', 'png', 'webp', 'heic'];

/**
 * The storage-key extension for an uploaded clip or B-roll file, or null when the
 * file is not a media type Kilo accepts. The file name's extension decides when it
 * has one; a name without one falls back to the content type.
 */
export function mediaExtension(filename: string, contentType: string, kind: 'clip' | 'broll'): string | null {
  const allowed = kind === 'clip' ? CLIP_EXTENSIONS : BROLL_EXTENSIONS;
  const fromName = /\.([A-Za-z0-9]{1,5})$/.exec(filename)?.[1]?.toLowerCase();
  const ext = fromName ?? EXT_BY_TYPE[contentType.toLowerCase().split(';')[0]!.trim()];
  if (!ext || !allowed.includes(ext)) return null;
  return ext === 'jpeg' ? 'jpg' : ext;
}

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

/** True when `key` sits under the video's own prefix: `users/<userId>/videos/<videoId>/…`. */
export function keyBelongsTo(key: string | null | undefined, userId: string, videoId: string): key is string {
  if (!key) return false;
  const prefix = `${keys.video(userId, videoId)}/`;
  return key.startsWith(prefix) && !key.slice(prefix.length).split('/').some((p) => p === '' || p === '.' || p === '..');
}

/** Parses `users/<u>/videos/<v>/(clips|broll)/<id>/source.<ext>`, the key of an upload target. */
export function parseSourceKey(key: string): { userId: string; videoId: string; kind: 'clip' | 'broll'; id: string } | null {
  const m = /^users\/([0-9a-f-]{36})\/videos\/([0-9a-f-]{36})\/(clips|broll)\/([0-9a-f-]{36})\/source\.[a-z0-9]{1,5}$/.exec(key);
  if (!m) return null;
  return { userId: m[1]!, videoId: m[2]!, kind: m[3] === 'clips' ? 'clip' : 'broll', id: m[4]! };
}

/** Rejects keys that could escape the bucket. */
export function assertSafeKey(key: string): void {
  if (!key || key.startsWith('/') || key.split('/').some((p) => p === '' || p === '.' || p === '..') || key.includes('\\')) {
    throw new Error(`Unsafe storage key: ${key}`);
  }
}
