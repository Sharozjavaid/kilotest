import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { color as palette } from './tokens';

/**
 * Line icons, 2px stroke, 24-unit grid. Paths copied from the mock-up where it has
 * them. Icons are decorative: the control that holds one carries the label.
 */
export type IconName =
  | 'settings'
  | 'upload'
  | 'camera'
  | 'chevronRight'
  | 'chevronLeft'
  | 'chevronUp'
  | 'chevronDown'
  | 'play'
  | 'pause'
  | 'videos'
  | 'broll'
  | 'styles'
  | 'user'
  | 'download'
  | 'share'
  | 'check'
  | 'close'
  | 'plus'
  | 'minus'
  | 'alert'
  | 'refresh'
  | 'merge'
  | 'split'
  | 'pencil'
  | 'sparkle'
  | 'wifiOff'
  | 'mail'
  | 'trash'
  | 'flip'
  | 'list'
  | 'bell'
  | 'search'
  | 'more';

export interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}

export function Icon({ name, size = 20, color = palette.ink, strokeWidth = 2 }: IconProps) {
  const common = {
    fill: 'none',
    stroke: color,
    strokeWidth,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden>
      {renderIcon(name, common, color)}
    </Svg>
  );
}

type Common = {
  fill: string;
  stroke: string;
  strokeWidth: number;
  strokeLinecap: 'round';
  strokeLinejoin: 'round';
};

function renderIcon(name: IconName, c: Common, fill: string) {
  switch (name) {
    case 'settings':
      return (
        <>
          <Path d="M4 7h10M18 7h2M4 17h2M10 17h10" {...c} />
          <Circle cx={16} cy={7} r={2} {...c} />
          <Circle cx={8} cy={17} r={2} {...c} />
        </>
      );
    case 'upload':
      return <Path d="M12 16V4M7 9l5-5 5 5M4 20h16" {...c} />;
    case 'download':
      return <Path d="M12 4v12M7 11l5 5 5-5M4 20h16" {...c} />;
    case 'camera':
      return (
        <>
          <Rect x={3} y={6} width={13} height={12} rx={3} {...c} />
          <Path d="M16 10l5-3v10l-5-3" {...c} />
        </>
      );
    case 'chevronRight':
      return <Path d="M9 5l7 7-7 7" {...c} />;
    case 'chevronLeft':
      return <Path d="M15 5l-7 7 7 7" {...c} />;
    case 'chevronUp':
      return <Path d="M5 15l7-7 7 7" {...c} />;
    case 'chevronDown':
      return <Path d="M5 9l7 7 7-7" {...c} />;
    case 'play':
      return <Path d="M8 5l12 7-12 7z" fill={fill} stroke="none" />;
    case 'pause':
      return (
        <>
          <Rect x={6} y={5} width={4} height={14} rx={1} fill={fill} stroke="none" />
          <Rect x={14} y={5} width={4} height={14} rx={1} fill={fill} stroke="none" />
        </>
      );
    case 'videos':
      return (
        <>
          <Rect x={4} y={3} width={16} height={18} rx={3} {...c} />
          <Path d="M10 9l5 3-5 3z" {...c} />
        </>
      );
    case 'broll':
      return (
        <>
          <Rect x={3} y={7} width={13} height={13} rx={2} {...c} />
          <Path d="M7 4h12a2 2 0 0 1 2 2v11" {...c} />
        </>
      );
    case 'styles':
      return <Path d="M4 7h16M4 12h10M4 17h13" {...c} />;
    case 'user':
      return (
        <>
          <Circle cx={12} cy={8} r={4} {...c} />
          <Path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" {...c} />
        </>
      );
    case 'share':
      return <Path d="M12 15V3M7 8l5-5 5 5M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" {...c} />;
    case 'check':
      return <Path d="M5 12.5l4.5 4.5L19 7.5" {...c} />;
    case 'close':
      return <Path d="M6 6l12 12M18 6L6 18" {...c} />;
    case 'plus':
      return <Path d="M12 5v14M5 12h14" {...c} />;
    case 'minus':
      return <Path d="M5 12h14" {...c} />;
    case 'alert':
      return (
        <>
          <Circle cx={12} cy={12} r={9} {...c} />
          <Path d="M12 7.5v5.5M12 16.5v.01" {...c} />
        </>
      );
    case 'refresh':
      return <Path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" {...c} />;
    case 'merge':
      return <Path d="M6 4v5a5 5 0 0 0 5 5h7M15 11l3 3-3 3M6 20v-3" {...c} />;
    case 'split':
      return <Path d="M12 4v16M4 8l4 4-4 4M20 8l-4 4 4 4" {...c} />;
    case 'pencil':
      return <Path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" {...c} />;
    case 'sparkle':
      return <Path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6" {...c} />;
    case 'wifiOff':
      return <Path d="M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 12.5a10 10 0 0 1 5-2.6M14.5 10a10 10 0 0 1 4.5 2.5M12 20h.01" {...c} />;
    case 'trash':
      return <Path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" {...c} />;
    case 'flip':
      return <Path d="M4 9a8 8 0 0 1 14-4l2 2M20 4v3h-3M20 15a8 8 0 0 1-14 4l-2-2M4 20v-3h3" {...c} />;
    case 'list':
      return <Path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" {...c} />;
    case 'search':
      return (
        <>
          <Circle cx={11} cy={11} r={6.5} {...c} />
          <Path d="M16 16l4.5 4.5" {...c} />
        </>
      );
    case 'more':
      return (
        <>
          <Circle cx={5.5} cy={12} r={1.6} fill={fill} stroke="none" />
          <Circle cx={12} cy={12} r={1.6} fill={fill} stroke="none" />
          <Circle cx={18.5} cy={12} r={1.6} fill={fill} stroke="none" />
        </>
      );
    case 'bell':
      return <Path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0" {...c} />;
    case 'mail':
      return (
        <>
          <Rect x={3} y={5} width={18} height={14} rx={3} {...c} />
          <Path d="M4 7l8 6 8-6" {...c} />
        </>
      );
  }
}
