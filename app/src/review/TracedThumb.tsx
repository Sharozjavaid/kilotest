import { View } from 'react-native';
import Animated, { useAnimatedProps } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { Thumb } from '@/ui/Thumb';
import { useMotionValue } from '@/ui/motion';
import { useColors } from '@/ui/theme';
import { tracedBorder } from './traced';

const AnimatedPath = Animated.createAnimatedComponent(Path);

/**
 * Review's not-ready card (design brief 4.6): the clip's first frame at 120 x 213 with the
 * editing progress traced around its rounded border in `accent`, 3pt, moving with `progress`
 * (450 ms, never backwards). The one place Kilo uses the traced border.
 */
export function TracedThumb({ uri, cacheKey, progress, tone = 'accent' }: { uri: string | null; cacheKey?: string; progress: number | null; tone?: 'accent' | 'cut' }) {
  const c = useColors();
  const w = 120;
  const h = 213;
  const stroke = 3;
  const { d, length } = tracedBorder(w, h, 16, stroke / 2);
  const p = useMotionValue(Math.min(1, Math.max(0, progress ?? 0)), 'progress');
  const dash = useAnimatedProps(() => ({ strokeDashoffset: length * (1 - p.value) }), [length]);
  return (
    <View style={{ width: w, height: h }}>
      <Thumb uri={uri} width={w} height={h} r={16} cacheKey={cacheKey} />
      {progress !== null ? (
        <View style={{ position: 'absolute', top: 0, left: 0 }} pointerEvents="none">
          <Svg width={w} height={h}>
            <Path d={d} stroke={c.track} strokeWidth={stroke} fill="none" />
            <AnimatedPath d={d} stroke={tone === 'cut' ? c.cut : c.accent} strokeWidth={stroke} strokeLinecap="round" fill="none" strokeDasharray={`${length} ${length}`} animatedProps={dash} />
          </Svg>
        </View>
      ) : null}
    </View>
  );
}
