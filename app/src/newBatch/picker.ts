import * as ImagePicker from 'expo-image-picker';
import { getMockApi } from '@/api/client';
import type { PickedFile } from './grouping';

export class PickerPermissionError extends Error {
  constructor() {
    super('Kilo needs access to your library to pick clips. You can allow it in Settings.');
  }
}

function toPicked(a: ImagePicker.ImagePickerAsset, i: number): PickedFile {
  const isVideo = a.type === 'video' || (a.mimeType ?? '').startsWith('video/');
  const fallbackName = `${isVideo ? 'clip' : 'photo'}-${i + 1}.${isVideo ? 'mov' : 'jpg'}`;
  return {
    id: a.assetId ?? a.uri,
    uri: a.uri,
    filename: a.fileName ?? fallbackName,
    contentType: a.mimeType ?? (isVideo ? 'video/quicktime' : 'image/jpeg'),
    sizeBytes: a.fileSize ?? 0,
    kind: isVideo ? 'video' : 'image',
    durationSec: a.duration ? a.duration / 1000 : undefined,
  };
}

/** Picks several files from the library. `videos` for clips, `media` for B-roll (photos and videos). */
export async function pickFromLibrary(what: 'videos' | 'media'): Promise<PickedFile[]> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) throw new PickerPermissionError();
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: what === 'videos' ? ['videos'] : ['images', 'videos'],
    allowsMultipleSelection: true,
    orderedSelection: true,
    selectionLimit: what === 'videos' ? 60 : 30,
    // Keep the original file; the server normalises it.
    preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
    videoExportPreset: ImagePicker.VideoExportPreset.Passthrough,
    quality: 1,
  });
  if (res.canceled) return [];
  return res.assets.map(toPicked);
}

/** Mock mode only: sample files standing in for library picks (the web picker cannot be driven in tests). */
export function sampleFiles(what: 'videos' | 'media', count: number): PickedFile[] {
  if (!getMockApi()) return [];
  const stamp = Date.now().toString(36);
  const names = what === 'videos' ? ['Morning routine.mov', 'Unboxing.mov', 'Why I switched.mov', 'Desk tour.mov', 'Hook retake.mov'] : ['product.jpg', 'shelf.mov', 'stopwatch.jpg'];
  return Array.from({ length: count }, (_, i) => {
    const filename = names[i % names.length]!;
    const isVideo = /\.mov$/.test(filename);
    return {
      id: `sample-${stamp}-${i}`,
      uri: `mock://library/${filename}`,
      filename,
      contentType: isVideo ? 'video/quicktime' : 'image/jpeg',
      sizeBytes: isVideo ? 48_000_000 + i * 3_000_000 : 2_400_000,
      kind: isVideo ? 'video' : 'image',
      durationSec: isVideo ? 21 : undefined,
    } satisfies PickedFile;
  });
}
