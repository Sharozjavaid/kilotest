import React from 'react';
import { Composition, registerRoot } from 'remotion';
import { Graphic, type GraphicInput } from './Graphic';

export const COMPOSITION_ID = 'graphic';

const defaultProps: GraphicInput = {
  template: 'bold-title',
  props: { text: 'Nobody tells you this' },
  theme: { id: 'clean', name: 'Clean', fontFamily: 'Inter', background: '#FFFFFF', foreground: '#0B1220', accent: '#1F5EFF' },
  durationSec: 1.6,
  fps: 30,
  width: 1080,
  height: 1920,
  defaultDurationSec: 1.6,
};

const Root: React.FC = () => (
  <Composition
    id={COMPOSITION_ID}
    component={Graphic}
    defaultProps={defaultProps}
    width={1080}
    height={1920}
    fps={30}
    durationInFrames={48}
    calculateMetadata={({ props }) => ({
      durationInFrames: Math.max(1, Math.round(props.durationSec * props.fps)),
      fps: props.fps,
      width: props.width,
      height: props.height,
    })}
  />
);

registerRoot(Root);
