import { File } from 'expo-file-system';

/** Take files on iOS/Android live in the app's documents directory. */
export function takeFileExists(uri: string): boolean {
  try {
    return new File(uri).exists;
  } catch {
    return false;
  }
}

export function deleteTakeFile(uri: string): void {
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // Already gone.
  }
}

export function registerBlobUrl(_uri: string): void {}
