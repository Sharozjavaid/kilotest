import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { addNetworkStateListener } from 'expo-network';
import { useQueryClient } from '@tanstack/react-query';
import { getApi } from '@/api/client';
import { keys } from '@/api/queries';
import { onBeforeSignOut } from '@/auth/signOutHooks';
import { UploadQueue, type QueueStore, type UploadJob } from './queue';
import { setUploadActivity } from './activity';
import { createTransport } from './transports';
import { deleteTakeFile } from '@/recorder/files';
import { pendingStore } from '@/review/pendingStore';

/** Before uploads were kept per account. Read once for nobody, then removed. */
const LEGACY_KEY = 'kilo.uploads.v1';
export const storageKeyFor = (userId: string) => `kilo.uploads.v2.${userId}`;

let currentUser: string | null = null;

/** The queue is kept per signed-in account: signing in as someone else never replays the last account's files. */
export const asyncStorageStore: QueueStore = {
  async load() {
    if (!currentUser) return [];
    const raw = await AsyncStorage.getItem(storageKeyFor(currentUser));
    return raw ? (JSON.parse(raw) as UploadJob[]) : [];
  },
  async save(jobs) {
    if (!currentUser) return;
    await AsyncStorage.setItem(storageKeyFor(currentUser), JSON.stringify(jobs));
  },
};

let queue: UploadQueue | null = null;
let onStarted: (ids: string[]) => void = () => undefined;

/** The app's single upload queue, holding the signed-in account's files. */
export function getUploadQueue(): UploadQueue {
  if (!queue) {
    queue = new UploadQueue({
      transport: createTransport(),
      store: asyncStorageStore,
      complete: (body) => getApi().completeUploads(body),
      reissue: (body) => getApi().reissueUploads(body),
      concurrency: 3,
      // One video's files at a time: the first videos start editing while later ones upload.
      videosAtOnce: 1,
      maxAttempts: 5,
      onStarted: (ids) => onStarted(ids),
      discard: deleteTakeFile,
    });
    const q = queue;
    setUploadActivity({ canProgress: (id) => q.canProgress(id), canProgressBatch: (id) => q.canProgressBatch(id) });
  }
  return queue;
}

/** Points the queue at an account's stored jobs (or none). Running uploads of the previous account stop. */
export async function switchUploadUser(userId: string | null): Promise<void> {
  if (userId === currentUser) return;
  const q = getUploadQueue();
  await q.reset(false);
  currentUser = userId;
  await AsyncStorage.removeItem(LEGACY_KEY).catch(() => undefined);
  if (userId) await q.resume();
}

/** Sign-out: forget the account's queued uploads on this device. */
export async function clearUploadsForSignOut(): Promise<void> {
  const q = getUploadQueue();
  const user = currentUser;
  await q.reset(true);
  if (user) await AsyncStorage.removeItem(storageKeyFor(user)).catch(() => undefined);
  currentUser = null;
}

const EMPTY: readonly UploadJob[] = [];

/** Every upload job, live. */
export function useUploadJobs(): readonly UploadJob[] {
  const q = getUploadQueue();
  return useSyncExternalStore(
    (fn) => q.subscribe(fn),
    () => q.getJobs(),
    () => EMPTY,
  );
}

/** True while uploads are paused for want of a connection. */
export function useUploadsOffline(): boolean {
  const q = getUploadQueue();
  return useSyncExternalStore(
    (fn) => q.subscribe(fn),
    () => q.isOffline(),
    () => false,
  );
}

/**
 * Mount once under the query client, signed in, with the account's id. Resumes the
 * account's persisted queue on launch, when the app returns to the foreground and
 * when the network comes back.
 */
export function UploadManager({ userId }: { userId: string }) {
  const qc = useQueryClient();
  useEffect(() => {
    const q = getUploadQueue();
    onStarted = () => {
      void qc.invalidateQueries({ queryKey: keys.home });
      void qc.invalidateQueries({ queryKey: ['batch'] });
      void qc.invalidateQueries({ queryKey: ['video'] });
    };
    // Refresh screens as files finish or fail, so per-video status (and whether to keep polling) follows along.
    let last = '';
    const unsub = q.subscribe((jobs) => {
      const sig = `${jobs.filter((j) => j.status === 'done').length}/${jobs.filter((j) => j.status === 'failed').length}/${jobs.length}`;
      if (sig !== last) {
        last = sig;
        void qc.invalidateQueries({ queryKey: ['batch'] });
        void qc.invalidateQueries({ queryKey: keys.home });
      }
    });
    void switchUploadUser(userId);
    const offSignOut = onBeforeSignOut(async () => {
      await clearUploadsForSignOut();
      await pendingStore.clearAll();
    });
    const app = AppState.addEventListener('change', (s) => {
      if (s === 'active') void q.resume();
    });
    // Lost connection: stop running uploads without spending an attempt, start nothing; back: carry on.
    const net = addNetworkStateListener((s) => q.setOnline(s.isConnected !== false));
    return () => {
      unsub();
      offSignOut();
      app.remove();
      net.remove();
    };
  }, [qc, userId]);
  return null;
}
