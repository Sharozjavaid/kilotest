import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { addNetworkStateListener } from 'expo-network';
import { useQueryClient } from '@tanstack/react-query';
import { getApi } from '@/api/client';
import { keys } from '@/api/queries';
import { UploadQueue, type QueueStore, type UploadJob } from './queue';
import { createTransport } from './transports';
import { deleteTakeFile } from '@/recorder/files';

const STORAGE_KEY = 'kilo.uploads.v1';

export const asyncStorageStore: QueueStore = {
  async load() {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as UploadJob[]) : [];
  },
  async save(jobs) {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(jobs));
  },
};

let queue: UploadQueue | null = null;
let onStarted: (ids: string[]) => void = () => undefined;

/** The app's single upload queue. */
export function getUploadQueue(): UploadQueue {
  if (!queue) {
    queue = new UploadQueue({
      transport: createTransport(),
      store: asyncStorageStore,
      complete: (body) => getApi().completeUploads(body),
      concurrency: 3,
      maxAttempts: 5,
      onStarted: (ids) => onStarted(ids),
      discard: deleteTakeFile,
    });
  }
  return queue;
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

/**
 * Mount once under the query client (signed in). Resumes the persisted queue on
 * launch, when the app returns to the foreground and when the network comes back.
 */
export function UploadManager() {
  const qc = useQueryClient();
  useEffect(() => {
    const q = getUploadQueue();
    onStarted = () => {
      void qc.invalidateQueries({ queryKey: keys.home });
      void qc.invalidateQueries({ queryKey: ['batch'] });
      void qc.invalidateQueries({ queryKey: ['video'] });
    };
    // Refresh screens as files finish so per-video status follows along.
    let lastDone = 0;
    const unsub = q.subscribe((jobs) => {
      const done = jobs.filter((j) => j.status === 'done').length;
      if (done !== lastDone) {
        lastDone = done;
        void qc.invalidateQueries({ queryKey: ['batch'] });
      }
    });
    void q.resume();
    const app = AppState.addEventListener('change', (s) => {
      if (s === 'active') void q.resume();
    });
    const net = addNetworkStateListener((s) => {
      if (s.isConnected === false) q.pause();
      else void q.resume();
    });
    return () => {
      unsub();
      app.remove();
      net.remove();
    };
  }, [qc]);
  return null;
}
