import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { registerBlobUrl } from '../files';
import type { PermissionState, RecordedFile, RecorderCameraProps, RecorderPermissions } from './types';

/**
 * Web: getUserMedia + MediaRecorder, so the whole recorder flow runs in a browser.
 * Asks for 1080 x 1920 at 60 fps and reports what the browser actually delivers.
 * Takes are blob: URLs; they do not survive a page reload.
 */

function pickMime(): string {
  const MR = (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
  for (const t of ['video/mp4;codecs=avc1,mp4a', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']) {
    if (MR?.isTypeSupported?.(t)) return t;
  }
  return 'video/webm';
}

export function RecorderCamera({ facing, active, onCaptureInfo, onError, style, ref }: RecorderCameraProps) {
  const video = useRef<HTMLVideoElement | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const cb = useRef({ onCaptureInfo, onError });
  cb.current = { onCaptureInfo, onError };

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const md = (globalThis as { navigator?: Navigator }).navigator?.mediaDevices;
    if (!md?.getUserMedia) {
      cb.current.onError('This browser cannot use a camera.');
      return;
    }
    md.getUserMedia({
      video: { facingMode: facing === 'front' ? 'user' : 'environment', width: { ideal: 1080 }, height: { ideal: 1920 }, frameRate: { ideal: 60 } },
      audio: true,
    })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream.current = s;
        if (video.current) {
          video.current.srcObject = s;
          void video.current.play().catch(() => undefined);
        }
        const settings = s.getVideoTracks()[0]?.getSettings() ?? {};
        cb.current.onCaptureInfo({ fps: settings.frameRate ?? 30, width: settings.width ?? 0, height: settings.height ?? 0 });
      })
      .catch((e: unknown) => cb.current.onError(e instanceof Error ? `${e.name}: ${e.message}` : String(e)));
    return () => {
      cancelled = true;
      stream.current?.getTracks().forEach((t) => t.stop());
      stream.current = null;
    };
  }, [facing, active]);

  useImperativeHandle(
    ref,
    () => ({
      async start() {
        const s = stream.current;
        if (!s) throw new Error('The camera is not ready yet.');
        const mimeType = pickMime();
        const r = new MediaRecorder(s, { mimeType });
        chunks.current = [];
        r.ondataavailable = (e) => {
          if (e.data.size) chunks.current.push(e.data);
        };
        r.start(250);
        startedAt.current = Date.now();
        recorder.current = r;
      },
      stop() {
        const r = recorder.current;
        if (!r) return Promise.reject(new Error('Not recording'));
        return new Promise<RecordedFile>((resolve) => {
          r.onstop = () => {
            const type = r.mimeType.split(';')[0] || 'video/webm';
            const blob = new Blob(chunks.current, { type });
            const uri = URL.createObjectURL(blob);
            registerBlobUrl(uri);
            recorder.current = null;
            resolve({
              uri,
              filename: `take-${Date.now().toString(36)}.${type.includes('mp4') ? 'mp4' : 'webm'}`,
              contentType: type,
              sizeBytes: blob.size,
              durationSec: (Date.now() - startedAt.current) / 1000,
            });
          };
          r.stop();
        });
      },
      async cancel() {
        const r = recorder.current;
        recorder.current = null;
        if (r && r.state !== 'inactive') {
          r.onstop = null;
          r.stop();
        }
      },
    }),
    [],
  );

  return (
    <View style={[style, styles.wrap]}>
      <video
        ref={video}
        autoPlay
        muted
        playsInline
        style={{ width: '100%', height: '100%', objectFit: 'cover', transform: facing === 'front' ? 'scaleX(-1)' : undefined }}
      />
    </View>
  );
}

async function query(name: string): Promise<PermissionState> {
  const nav = (globalThis as { navigator?: Navigator }).navigator;
  if (!nav?.mediaDevices?.getUserMedia) return 'unavailable';
  try {
    const st = await nav.permissions.query({ name: name as PermissionName });
    return st.state === 'granted' ? 'granted' : st.state === 'denied' ? 'denied' : 'prompt';
  } catch {
    return 'prompt';
  }
}

export function useRecorderPermissions(): RecorderPermissions {
  const [camera, setCamera] = useState<PermissionState>('checking');
  const [microphone, setMicrophone] = useState<PermissionState>('checking');
  const refresh = useCallback(async () => {
    setCamera(await query('camera'));
    setMicrophone(await query('microphone'));
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return {
    camera,
    microphone,
    request: async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        s.getTracks().forEach((t) => t.stop());
        await refresh();
      } catch {
        // Refused (or dismissed): anything not granted now counts as denied, so the screen explains instead of asking again.
        const [cam, mic] = [await query('camera'), await query('microphone')];
        setCamera(cam === 'granted' ? cam : cam === 'unavailable' ? cam : 'denied');
        setMicrophone(mic === 'granted' ? mic : 'denied');
      }
    },
    openSettings: () => undefined,
    canOpenSettings: false,
  };
}

const styles = StyleSheet.create({
  wrap: { overflow: 'hidden' },
});
