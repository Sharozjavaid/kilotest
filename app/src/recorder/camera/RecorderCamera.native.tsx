import { useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import {
  Camera,
  CommonResolutions,
  useCameraDevice,
  useCameraPermission,
  useMicrophonePermission,
  useVideoOutput,
  type Constraint,
  type PermissionStatus,
  type Recorder,
} from 'react-native-vision-camera';
import { Text } from '@/ui/type';
import { chooseCapture } from './capture';
import type { PermissionState, RecordedFile, RecorderCameraProps, RecorderPermissions } from './types';

/**
 * iOS and Android: react-native-vision-camera (v5). Asks for 60 fps when the device
 * supports it, with the video output biased to 1080 x 1920; the fps the session
 * actually selected is reported back for the badge. Takes are written to
 * <documents>/recordings/ so a draft survives the app closing.
 */
export function RecorderCamera({ facing, active, onCaptureInfo, onError, style, ref }: RecorderCameraProps) {
  const device = useCameraDevice(facing);
  const videoOutput = useVideoOutput({ targetResolution: CommonResolutions.FHD_16_9, enableAudio: true, fileType: 'mp4' });
  const plan = useMemo(
    () => (device ? chooseCapture({ supportsFps: (f) => device.supportsFPS(f), videoResolutions: device.getSupportedResolutions('video') }) : null),
    [device],
  );
  const constraints = useMemo<Constraint[]>(() => (plan ? [{ fps: plan.fps }, { resolutionBias: videoOutput }] : []), [plan, videoOutput]);

  const recorder = useRef<Recorder | null>(null);
  const finished = useRef<Promise<string> | null>(null);
  const meta = useRef<{ name: string; startedAt: number } | null>(null);

  useEffect(() => {
    if (device === undefined) return;
    if (!device) onError('No camera found on this device.');
  }, [device, onError]);

  useImperativeHandle(
    ref,
    () => ({
      async start() {
        const dir = new Directory(Paths.document, 'recordings');
        if (!dir.exists) dir.create({ intermediates: true });
        const name = `take-${Date.now().toString(36)}.mp4`;
        const target = new File(dir, name);
        const r = await videoOutput.createRecorder({ filePath: decodeURIComponent(target.uri.replace(/^file:\/\//, '')) });
        finished.current = new Promise<string>((resolve, reject) => {
          void r.startRecording(
            (filePath) => resolve(filePath),
            (e) => reject(e),
          ).catch(reject);
        });
        recorder.current = r;
        meta.current = { name, startedAt: Date.now() };
      },
      async stop(): Promise<RecordedFile> {
        const r = recorder.current;
        const m = meta.current;
        if (!r || !m || !finished.current) throw new Error('Not recording');
        const seconds = r.recordedDuration || (Date.now() - m.startedAt) / 1000;
        await r.stopRecording();
        const path = await finished.current;
        recorder.current = null;
        const uri = path.startsWith('file://') ? path : `file://${path}`;
        const file = new File(uri);
        return { uri, filename: m.name, contentType: 'video/mp4', sizeBytes: file.exists ? file.size : 0, durationSec: seconds };
      },
      async cancel() {
        const r = recorder.current;
        recorder.current = null;
        if (r?.isRecording) await r.cancelRecording().catch(() => undefined);
      },
    }),
    [videoOutput],
  );

  if (!device) {
    return (
      <View style={[style, styles.missing]}>
        <Text tone="white">Looking for a camera…</Text>
      </View>
    );
  }
  return (
    <Camera
      style={style}
      device={device}
      isActive={active}
      outputs={[videoOutput]}
      constraints={constraints}
      mirrorMode="auto"
      resizeMode="cover"
      onSessionConfigSelected={(config) =>
        onCaptureInfo({ fps: config.selectedFPS ?? plan?.fps ?? 30, width: plan?.width ?? 1080, height: plan?.height ?? 1920 })
      }
      onError={(e) => onError(e.message)}
    />
  );
}

function map(s: PermissionStatus): PermissionState {
  if (s === 'authorized') return 'granted';
  if (s === 'not-determined') return 'prompt';
  return 'denied';
}

export function useRecorderPermissions(): RecorderPermissions {
  const cam = useCameraPermission();
  const mic = useMicrophonePermission();
  return {
    camera: map(cam.status),
    microphone: map(mic.status),
    request: async () => {
      if (cam.canRequestPermission) await cam.requestPermission();
      if (mic.canRequestPermission) await mic.requestPermission();
    },
    openSettings: () => void Linking.openSettings(),
    canOpenSettings: true,
  };
}

const styles = StyleSheet.create({
  missing: { alignItems: 'center', justifyContent: 'center' },
});
