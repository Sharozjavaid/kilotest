import React, { useEffect, useRef, useState } from 'react';
import { AbsoluteFill, continueRender, delayRender, useCurrentFrame } from 'remotion';
import type { TemplateComponentProps } from './common';
import { loadFallbackFonts, loadFonts } from './fonts';
import { makeClock } from './motion';
import { probeLayout } from './probe';
import { setTextHint, textOf } from './scripts';
import { DESIGN_WIDTH, safeArea, type ThemeInput } from './style';
import { BoldTitle } from './templates/BoldTitle';
import { KeywordPop } from './templates/KeywordPop';
import { NumberedList } from './templates/NumberedList';
import { PriceTag } from './templates/PriceTag';
import { StatCallout } from './templates/StatCallout';

/** Input props of the `graphic` composition. Built on the Node side from a RenderGraphicRequest. */
export interface GraphicInput {
  [key: string]: unknown;
  template: string;
  props: Record<string, unknown>;
  theme: ThemeInput;
  durationSec: number;
  fps: number;
  width: number;
  height: number;
  /** The catalog default duration; timings are designed at this length. */
  defaultDurationSec: number;
  /** Acceptance sweep only: measure the drawn layout and print it (see probe.ts). Never set by the renderer. */
  probe?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const COMPONENTS: Record<string, React.FC<TemplateComponentProps<any>>> = {
  'bold-title': BoldTitle,
  'numbered-list': NumberedList,
  'stat-callout': StatCallout,
  'keyword-pop': KeywordPop,
  'price-tag': PriceTag,
};

export const Graphic: React.FC<GraphicInput> = (input) => {
  const frame = useCurrentFrame();
  const [handle] = useState(() => delayRender('Loading bundled fonts'));
  const [ready, setReady] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const [probeHandle] = useState(() => (input.probe ? delayRender('Measuring the layout') : null));
  useEffect(() => {
    loadFonts()
      .then(() => loadFallbackFonts(textOf(input.props)))
      .then(() => {
        setReady(true);
        continueRender(handle);
      })
      .catch((err) => {
        console.error(err);
        throw err;
      });
  }, [handle]);

  useEffect(() => {
    if (!ready || probeHandle === null || !root.current) return;
    console.log(`KILO_PROBE ${JSON.stringify({ frame, ...probeLayout(root.current, input.width, input.height) })}`);
    continueRender(probeHandle);
  }, [ready, frame, probeHandle, input.width, input.height]);

  if (!ready) return null;
  // Orders the Chinese, Japanese and Korean faces for this graphic's text before anything is measured.
  setTextHint(textOf(input.props));
  const Component = COMPONENTS[input.template];
  if (!Component) throw new Error(`Unknown template: ${input.template}`);

  const scale = input.width / DESIGN_WIDTH;
  const designHeight = input.height / scale;
  const clock = makeClock(frame, input.fps, input.durationSec, input.defaultDurationSec);
  return (
    <AbsoluteFill ref={root} style={{ backgroundColor: 'transparent', overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: DESIGN_WIDTH,
          height: designHeight,
          transform: `scale(${scale})`,
          transformOrigin: '0 0',
          WebkitFontSmoothing: 'antialiased',
          textRendering: 'geometricPrecision',
        }}
      >
        <Component props={input.props} theme={input.theme} clock={clock} area={safeArea(designHeight)} />
      </div>
    </AbsoluteFill>
  );
};
