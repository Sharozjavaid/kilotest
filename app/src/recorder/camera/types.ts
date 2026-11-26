import type { Ref } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

/**
 * The camera behind the recorder, implemented twice and chosen by Metro's platform
 * extension: RecorderCamera.native.tsx (react-native-vision-camera) and
 * RecorderCamera.web.tsx (getUserMedia + MediaRecorder, so the flow runs in a browser).
 */

/** What is actually being captured, for the badge. */
export interface CaptureInfo {
  fps: number;
  width: number;
  height: number;
}

/** A finished take on disk (native) or in memory (web). */
export interface RecordedFile {
  uri: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  durationSec: number;
}

export interface RecorderCameraHandle {
  /** Starts recording video with audio. Rejects when the camera is not ready. */
  start(): Promise<void>;
  /** Stops and resolves with the file. */
  stop(): Promise<RecordedFile>;
  /** Stops and throws the recording away. */
  cancel(): Promise<void>;
}

export interface RecorderCameraProps {
  facing: 'front' | 'back';
  /** False pauses the camera (screen not focused, app in background). */
  active: boolean;
  onCaptureInfo: (info: CaptureInfo) => void;
  onError: (message: string) => void;
  style?: StyleProp<ViewStyle>;
  ref?: Ref<RecorderCameraHandle>;
}

export type PermissionState = 'checking' | 'prompt' | 'granted' | 'denied' | 'unavailable';

export interface RecorderPermissions {
  camera: PermissionState;
  microphone: PermissionState;
  /** Asks for whichever of camera and microphone can still be asked for. */
  request: () => Promise<void>;
  /** Opens the system settings for the app (native) — a no-op on web. */
  openSettings: () => void;
  /** Settings can be opened from the app (native only). */
  canOpenSettings: boolean;
}
