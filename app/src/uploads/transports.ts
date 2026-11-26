import { Platform } from 'react-native';
import { File, UploadTask, UploadType } from 'expo-file-system';
import * as tus from 'tus-js-client';
import type { TransportCallbacks, UploadJob, UploadTransport } from './queue';

/**
 * How bytes leave the device, by target kind:
 * - `put`: one HTTP PUT. On iOS/Android this is expo-file-system's UploadTask with a
 *   background URL session, so it keeps going while the app is suspended.
 * - `tus`: resumable upload (Supabase Storage) with tus-js-client; the upload URL is
 *   saved on the job so a relaunch continues from the last chunk.
 * - `mock://` URLs (mock mode): simulated progress, no network.
 */
export function createTransport(): UploadTransport {
  return {
    upload(job, cb) {
      if (job.target.url.startsWith('mock://')) return mockUpload(job, cb);
      if (job.target.kind === 'tus') return tusUpload(job, cb);
      return Platform.OS === 'web' ? webPut(job, cb) : nativePut(job, cb);
    },
  };
}

async function nativePut(job: UploadJob, cb: TransportCallbacks): Promise<void> {
  const task = new UploadTask(new File(job.fileUri), job.target.url, {
    httpMethod: 'PUT',
    uploadType: UploadType.BINARY_CONTENT,
    headers: { 'Content-Type': job.contentType, ...job.target.headers },
    mimeType: job.contentType,
    sessionType: 'background',
    onProgress: (p) => cb.onProgress(p.bytesSent, p.totalBytes),
    signal: cb.signal,
  });
  try {
    const res = await task.uploadAsync();
    if (res.status < 200 || res.status >= 300) throw httpError(res.status);
  } finally {
    task.release();
  }
}

async function webPut(job: UploadJob, cb: TransportCallbacks): Promise<void> {
  const blob = await (await fetch(job.fileUri)).blob();
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', job.target.url);
    xhr.setRequestHeader('Content-Type', job.contentType);
    for (const [k, v] of Object.entries(job.target.headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => cb.onProgress(e.loaded, e.total || blob.size);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(httpError(xhr.status)));
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.onabort = () => reject(new Error('Upload cancelled'));
    cb.signal.addEventListener('abort', () => xhr.abort());
    xhr.send(blob);
  });
}

async function tusUpload(job: UploadJob, cb: TransportCallbacks): Promise<void> {
  const file: unknown =
    Platform.OS === 'web' ? await (await fetch(job.fileUri)).blob() : { uri: job.fileUri, name: job.filename, type: job.contentType };
  await new Promise<void>((resolve, reject) => {
    const upload = new tus.Upload(file as Blob, {
      endpoint: job.target.url,
      uploadUrl: job.resumeUrl ?? null,
      headers: job.target.headers,
      // The queue does its own retries with backoff.
      retryDelays: [],
      // Supabase Storage requires 6 MB chunks.
      chunkSize: 6 * 1024 * 1024,
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      uploadSize: job.sizeBytes || undefined,
      metadata: {
        bucketName: job.target.bucket,
        objectName: job.target.objectKey,
        contentType: job.contentType,
        cacheControl: '3600',
      },
      onUploadUrlAvailable: () => {
        if (upload.url) cb.onResumeUrl?.(upload.url);
      },
      onProgress: (sent, total) => cb.onProgress(sent, total),
      onSuccess: () => resolve(),
      // The status tells the queue an expired or refused upload link from a network failure.
      onError: (e) => {
        const status = (e as { originalResponse?: { getStatus?: () => number } | null }).originalResponse?.getStatus?.();
        reject(typeof status === 'number' && status > 0 ? Object.assign(e, { status }) : e);
      },
    });
    cb.signal.addEventListener('abort', () => {
      void upload.abort();
      reject(new Error('Upload cancelled'));
    });
    upload.start();
  });
}

/** An upload answered with an error status; the queue reads `status` (401/403/404/410: ask for a fresh target). */
function httpError(status: number): Error {
  return Object.assign(new Error(`Upload failed (${status})`), { status });
}

/** Mock mode: progress over one to three seconds; nothing is sent. */
function mockUpload(job: UploadJob, cb: TransportCallbacks): Promise<void> {
  const total = Math.max(1, job.sizeBytes);
  const steps = 8 + Math.floor(Math.random() * 8);
  return new Promise((resolve, reject) => {
    let i = 0;
    const timer = setInterval(() => {
      i += 1;
      cb.onProgress(Math.round((total * i) / steps), total);
      if (i >= steps) {
        clearInterval(timer);
        resolve();
      }
    }, 180);
    cb.signal.addEventListener('abort', () => {
      clearInterval(timer);
      reject(new Error('Upload cancelled'));
    });
  });
}
