import type { PickedFile } from './grouping';

/**
 * Turning an image-picker asset into a PickedFile. Pure (no native imports) so it is
 * unit-tested. The picker differs by platform:
 * - `duration` is milliseconds on iOS/Android but seconds on web (it is the
 *   <video> element's `duration` there);
 * - `fileSize` can be missing on Android and for some iCloud assets, and the server
 *   needs the exact size (CONTRACTS.md section 5), so the caller passes a way to
 *   read it from the file;
 * - `mimeType` can be missing; it is inferred from the file name.
 */
export interface PickerAsset {
  uri: string;
  assetId?: string | null;
  type?: 'image' | 'video' | 'livePhoto' | 'pairedVideo' | string | null;
  mimeType?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  duration?: number | null;
  /** Web only: the File the user picked. */
  file?: { size: number; type?: string; name?: string } | null;
}

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
  heif: 'image/heif',
};

export function contentTypeFromName(filename: string): string | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(filename)?.[1]?.toLowerCase();
  return ext ? TYPE_BY_EXT[ext] ?? null : null;
}

export function toPickedFile(
  a: PickerAsset,
  i: number,
  opts: { platform: 'web' | 'ios' | 'android' | string; sizeOf?: (uri: string) => number | null },
): PickedFile {
  const named = a.fileName ?? a.file?.name ?? null;
  const mime = a.mimeType || a.file?.type || (named ? contentTypeFromName(named) : null);
  const isVideo = a.type === 'video' || (mime ?? '').startsWith('video/');
  const filename = named ?? `${isVideo ? 'clip' : 'photo'}-${i + 1}.${isVideo ? 'mov' : 'jpg'}`;
  const size = a.fileSize ?? a.file?.size ?? opts.sizeOf?.(a.uri) ?? null;
  const duration = typeof a.duration === 'number' && a.duration > 0 ? (opts.platform === 'web' ? a.duration : a.duration / 1000) : undefined;
  return {
    id: a.assetId ?? a.uri,
    uri: a.uri,
    filename,
    contentType: mime ?? (isVideo ? 'video/quicktime' : 'image/jpeg'),
    sizeBytes: size !== null && Number.isFinite(size) && size >= 0 ? Math.round(size) : 0,
    kind: isVideo ? 'video' : 'image',
    durationSec: duration,
  };
}
