import AsyncStorage from '@react-native-async-storage/async-storage';
import type { PendingSnapshot } from './reconcile';

/**
 * Review edits not yet saved, per video, on the device. Written on every change, so a
 * failed save survives leaving the screen (or the app), and replayed when the video is
 * opened again. Removed once everything is saved, and on sign-out.
 */
const PREFIX = 'kilo.pendingEdl.';

export const pendingStore = {
  async load(videoId: string): Promise<PendingSnapshot | null> {
    try {
      const raw = await AsyncStorage.getItem(PREFIX + videoId);
      const snap = raw ? (JSON.parse(raw) as PendingSnapshot) : null;
      return snap && snap.videoId === videoId ? snap : null;
    } catch {
      return null;
    }
  },
  save(videoId: string, snapshot: PendingSnapshot | null): void {
    const op = snapshot ? AsyncStorage.setItem(PREFIX + videoId, JSON.stringify(snapshot)) : AsyncStorage.removeItem(PREFIX + videoId);
    void op.catch(() => undefined);
  },
  async clearAll(): Promise<void> {
    const all = await AsyncStorage.getAllKeys().catch(() => [] as readonly string[]);
    const mine = all.filter((k) => k.startsWith(PREFIX));
    if (mine.length) await AsyncStorage.multiRemove(mine).catch(() => undefined);
  },
};
