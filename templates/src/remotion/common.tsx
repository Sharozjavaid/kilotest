import React from 'react';
import type { Clock } from './motion';
import { ease, progress } from './motion';
import type { SafeArea, ThemeInput } from './style';

export interface TemplateComponentProps<P> {
  props: P;
  theme: ThemeInput;
  clock: Clock;
  area: SafeArea;
}

/**
 * Timing of the full-screen plate: an accent sheet leads, the background
 * sheet follows it up, and both leave upwards at the end. The speaker is
 * never hard-cut to a flat colour.
 */
export function plateMotion(c: Clock, height: number) {
  const k = c.k;
  const inDur = 0.36 * k;
  const lag = 0.07 * k;
  const accentIn = ease.outQuart(progress(c.t, 0, inDur));
  const plateIn = ease.outQuart(progress(c.t, lag, inDur));

  const outDur = Math.min(0.3 * k, c.end * 0.25);
  const outLag = Math.min(0.06 * k, outDur * 0.3);
  const plateOut = ease.inCubic(progress(c.t, c.end - outDur - outLag, outDur));
  const accentOut = ease.inCubic(progress(c.t, c.end - outDur, outDur));

  return {
    accentY: (1 - accentIn) * height - accentOut * height,
    plateY: (1 - plateIn) * height - plateOut * height,
    /** When the content may start its own entrance. */
    contentStart: lag + inDur * 0.45,
  };
}

export const Plate: React.FC<{ clock: Clock; theme: ThemeInput; height: number; children?: React.ReactNode }> = ({ clock, theme, height, children }) => {
  const m = plateMotion(clock, height);
  return (
    <>
      <div style={{ position: 'absolute', left: 0, top: 0, width: '100%', height, background: theme.accent, transform: `translateY(${m.accentY}px)` }} />
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: '100%',
          height,
          background: theme.background,
          transform: `translateY(${m.plateY}px)`,
          overflow: 'hidden',
        }}
      >
        {children}
      </div>
    </>
  );
};
