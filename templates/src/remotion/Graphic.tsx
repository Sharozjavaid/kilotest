import React, { useEffect, useState } from 'react';
import { AbsoluteFill, continueRender, delayRender, useCurrentFrame } from 'remotion';
import type { TemplateComponentProps } from './common';
import { loadFonts } from './fonts';
import { makeClock } from './motion';
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
  useEffect(() => {
    loadFonts()
      .then(() => {
        setReady(true);
        continueRender(handle);
      })
      .catch((err) => {
        console.error(err);
        throw err;
      });
  }, [handle]);

  if (!ready) return null;
  const Component = COMPONENTS[input.template];
  if (!Component) throw new Error(`Unknown template: ${input.template}`);

  const scale = input.width / DESIGN_WIDTH;
  const designHeight = input.height / scale;
  const clock = makeClock(frame, input.fps, input.durationSec, input.defaultDurationSec);
  return (
    <AbsoluteFill style={{ backgroundColor: 'transparent', overflow: 'hidden' }}>
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
