import type { CaptureInfo } from './types';

/**
 * Choosing the capture format (pure, so it is unit-tested): 1080 x 1920 at 60 fps
 * when the device has it, otherwise 30 fps; never above 1080p (uploads stay small).
 */

export interface Size {
  width: number;
  height: number;
}

export interface CapturePlan {
  fps: 60 | 30;
  /** Portrait size we ask for. */
  width: number;
  height: number;
}

/** Long and short side of a size, whatever its orientation. */
function sides(s: Size): [number, number] {
  return [Math.max(s.width, s.height), Math.min(s.width, s.height)];
}

/**
 * Picks the best video size at or under 1080 x 1920 among those the device supports
 * (any orientation), and 60 fps when the device supports it.
 */
export function chooseCapture(device: { supportsFps: (fps: number) => boolean; videoResolutions: readonly Size[] }): CapturePlan {
  const fits = device.videoResolutions
    .map(sides)
    .filter(([long, short]) => long <= 1920 && short <= 1080 && Math.abs(long / short - 16 / 9) < 0.02)
    .sort((a, b) => b[1] - a[1]);
  const [long, short] = fits[0] ?? [1920, 1080];
  return { fps: device.supportsFps(60) ? 60 : 30, width: short, height: long };
}

/** "1080p", "720p", "4K". */
export function resolutionLabel(info: Pick<CaptureInfo, 'width' | 'height'>): string {
  const short = Math.min(info.width, info.height);
  if (!short) return '';
  if (short >= 2160) return '4K';
  return `${short}p`;
}

/** "60 fps", rounded the way the badge shows it (59.94 reads as 60). */
export function fpsLabel(fps: number): string {
  return `${Math.round(fps)} fps`;
}

/** True when the capture is the full target: 60 fps at 1080p. */
export function isFullQuality(info: CaptureInfo): boolean {
  return Math.round(info.fps) >= 59 && Math.min(info.width, info.height) >= 1080;
}
