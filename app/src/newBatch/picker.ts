import { Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { File } from 'expo-file-system';
import { getMockApi } from '@/api/client';
import type { PickedFile } from './grouping';
import { toPickedFile } from './pickedFile';

export class PickerPermissionError extends Error {
  constructor() {
    super('Kilo needs access to your library to pick clips. You can allow it in Settings.');
  }
}

export class UnsupportedFileError extends Error {}

/** Exact size of a local file (the server checks it), when the picker did not say. */
function nativeSize(uri: string): number | null {
  if (Platform.OS === 'web') return null;
  try {
    const f = new File(uri);
    return f.exists ? f.size : null;
  } catch {
    return null;
  }
}

function toPicked(a: ImagePicker.ImagePickerAsset, i: number): PickedFile {
  return toPickedFile(a, i, { platform: Platform.OS, sizeOf: nativeSize });
}

/** Picks several files from the library. `videos` for clips, `media` for B-roll (photos and videos). */
export async function pickFromLibrary(what: 'videos' | 'media'): Promise<PickedFile[]> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) throw new PickerPermissionError();
  let res: ImagePicker.ImagePickerResult;
  try {
    res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: what === 'videos' ? ['videos'] : ['images', 'videos'],
    allowsMultipleSelection: true,
    orderedSelection: true,
    selectionLimit: what === 'videos' ? 60 : 30,
    // Keep the original file; the server normalises it.
    preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
    videoExportPreset: ImagePicker.VideoExportPreset.Passthrough,
    quality: 1,
    });
  } catch (e) {
    // The web picker rejects anything that is not an image or a video ("Unsupported file type: text/plain").
    const m = /Unsupported file type: ([^.]+)/.exec(e instanceof Error ? e.message : '');
    if (m) throw new UnsupportedFileError(`Kilo can only use videos${what === 'media' ? ' and photos' : ''}. One of the files you picked is ${m[1] || 'something else'}.`);
    throw e;
  }
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
