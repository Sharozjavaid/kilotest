import { Platform } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';

/**
 * Getting finished videos off the server: download to the cache, save to the
 * camera roll, or hand to the system share sheet. Kilo does not post to TikTok or
 * Instagram itself; the share sheet lets the creator pick the app.
 */

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9 ._-]/g, '').replace(/\s+/g, '-').slice(0, 80) || 'kilo-video';
}

/** Downloads a (signed) render URL into the cache. Returns a local file URI. */
export async function downloadToCache(url: string, name: string): Promise<string> {
  if (Platform.OS === 'web') return url;
  const dir = new Directory(Paths.cache, 'exports');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const file = new File(dir, `${safeName(name)}.mp4`);
  const out = await File.downloadFileAsync(url, file, { idempotent: true });
  return out.uri;
}

export class PermissionError extends Error {}

/** Saves files to the camera roll. Asks for add-only permission. */
export async function saveToCameraRoll(items: Array<{ url: string; name: string }>): Promise<number> {
  if (Platform.OS === 'web') {
    for (const it of items) await webDownload(it.url, `${safeName(it.name)}.mp4`);
    return items.length;
  }
  const perm = await MediaLibrary.requestPermissionsAsync(true);
  if (!perm.granted) throw new PermissionError('Kilo needs permission to add videos to your library. You can allow it in Settings.');
  let saved = 0;
  for (const it of items) {
    const local = await downloadToCache(it.url, it.name);
    await MediaLibrary.Asset.create(local);
    saved += 1;
  }
  return saved;
}

/** Downloads one version and opens the system share sheet with it. */
export async function shareVideo(url: string, name: string, dialogTitle: string): Promise<void> {
  if (Platform.OS === 'web') {
    const nav = globalThis.navigator as Navigator & { share?: (d: { title?: string; url?: string }) => Promise<void> };
    if (nav?.share) await nav.share({ title: dialogTitle, url });
    else await webDownload(url, `${safeName(name)}.mp4`);
    return;
  }
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device.');
  const local = await downloadToCache(url, name);
  await Sharing.shareAsync(local, { mimeType: 'video/mp4', UTI: 'public.mpeg-4', dialogTitle });
}

/**
 * Browsers ignore `download` on a cross-origin link (the API serves files from another
 * origin) and navigate to the video instead, leaving the app. Fetch the bytes and save
 * them through a same-origin blob: URL.
 */
async function webDownload(url: string, filename: string): Promise<void> {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`The download failed (${res.status}). Try again.`);
  const blobUrl = URL.createObjectURL(await res.blob());
  const a = doc.createElement('a');
  a.href = blobUrl;
  a.download = filename;
  a.rel = 'noopener';
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
}
