import { chooseCapture, fpsLabel, isFullQuality, resolutionLabel } from './capture';

describe('choosing the capture format', () => {
  it('takes 1080 x 1920 at 60 fps when the device has it', () => {
    const plan = chooseCapture({ supportsFps: (f) => f <= 60, videoResolutions: [{ width: 3840, height: 2160 }, { width: 1920, height: 1080 }, { width: 1280, height: 720 }] });
    expect(plan).toEqual({ fps: 60, width: 1080, height: 1920 });
  });

  it('falls back to 30 fps, and to the best 16:9 size under 1080p', () => {
    const plan = chooseCapture({ supportsFps: (f) => f <= 30, videoResolutions: [{ width: 1280, height: 720 }, { width: 640, height: 480 }] });
    expect(plan).toEqual({ fps: 30, width: 720, height: 1280 });
  });

  it('labels what is captured honestly', () => {
    expect(fpsLabel(59.94)).toBe('60 fps');
    expect(resolutionLabel({ width: 1080, height: 1920 })).toBe('1080p');
    expect(resolutionLabel({ width: 640, height: 480 })).toBe('480p');
    expect(isFullQuality({ fps: 30, width: 1080, height: 1920 })).toBe(false);
    expect(isFullQuality({ fps: 60, width: 1080, height: 1920 })).toBe(true);
  });
});
