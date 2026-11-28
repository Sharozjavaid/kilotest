import { memo, useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withSpring, type SharedValue } from 'react-native-reanimated';
import { formatDuration } from '@/lib/format';
import { springs } from '@/ui/motionPresets';
import { makeStyles } from '@/ui/theme';
import { Text } from '@/ui/type';
import type { ScrubMark, ScrubSpan } from './versions';

const H = 36;
const BAR = 8;
const KNOB = 10;
const KNOB_DRAG = 14;

const useStyles = makeStyles((t) => ({
  strip: { height: H, position: 'relative' },
  bar: { position: 'absolute', left: 0, right: 0, top: (H - BAR) / 2, height: BAR, borderRadius: BAR / 2, backgroundColor: t.color.accent, opacity: t.scheme === 'dark' ? 0.35 : 0.22 },
  span: { position: 'absolute', top: (H - BAR) / 2, height: BAR, borderRadius: BAR / 2, backgroundColor: t.color.accent },
  mark: { position: 'absolute', top: 6, width: 3, height: H - 12, marginLeft: -1.5, borderRadius: 1.5 },
  markCut: { backgroundColor: t.color.cut },
  markAccent: { backgroundColor: t.color.accent },
  playhead: { position: 'absolute', top: 0, left: 0, width: 2, height: H, marginLeft: -1, borderRadius: 1, backgroundColor: t.color.ink, alignItems: 'center' },
  knob: { position: 'absolute', top: -KNOB_DRAG / 2, left: 1 - KNOB_DRAG / 2, width: KNOB_DRAG, height: KNOB_DRAG, borderRadius: KNOB_DRAG / 2, backgroundColor: t.color.ink },
  labels: { flexDirection: 'row', justifyContent: 'space-between' },
}));

/**
 * The compare scrub bar: the newer version's length, its cuts as marks in `cut` and its B-roll
 * and graphic changes as spans in `accent`, and the playhead (2pt `ink`, a 10pt knob growing to
 * 14 while dragging). Drag to scrub both players. Content, never glass. The playhead follows the
 * leader's output time, a shared value written every frame, so it moves without re-renders.
 */
export const CompareScrub = memo(function CompareScrub({
  duration,
  time,
  marks,
  spans,
  onScrub,
  onScrubEnd,
}: {
  duration: number;
  time: SharedValue<number>;
  marks: readonly ScrubMark[];
  spans: readonly ScrubSpan[];
  onScrub: (t: number) => void;
  onScrubEnd: () => void;
}) {
  const s = useStyles();
  const [width, setWidth] = useState(0);
  const geo = useRef({ width, duration });
  geo.current = { width, duration };
  const cb = useRef({ onScrub, onScrubEnd });
  cb.current = { onScrub, onScrubEnd };
  const dragging = useSharedValue(0);

  const pan = useMemo(() => {
    const at = (e: GestureResponderEvent) => {
      const { width: w, duration: d } = geo.current;
      if (w <= 0 || d <= 0) return;
      const x = Math.max(0, Math.min(e.nativeEvent.locationX, w));
      cb.current.onScrub(Math.min((x / w) * d, Math.max(0, d - 0.05)));
    };
    const end = () => {
      dragging.value = withSpring(0, { ...springs.select, reduceMotion: ReduceMotion.System });
      cb.current.onScrubEnd();
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        dragging.value = withSpring(1, { ...springs.select, reduceMotion: ReduceMotion.System });
        at(e);
      },
      onPanResponderMove: at,
      onPanResponderRelease: end,
      onPanResponderTerminate: end,
    });
  }, [dragging]);

  const head = useAnimatedStyle(() => {
    const x = width && duration > 0 ? Math.max(1, Math.min(width - 1, (time.value / duration) * width)) : 0;
    return { transform: [{ translateX: x }] };
  }, [width, duration]);
  const knob = useAnimatedStyle(() => ({ transform: [{ scale: (KNOB + (KNOB_DRAG - KNOB) * dragging.value) / KNOB_DRAG }] }));
  const cuts = marks.filter((m) => m.tone === 'cut').length;

  return (
    <View style={{ gap: 6 }}>
      <View
        style={s.strip}
        onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
        accessibilityRole="adjustable"
        accessibilityLabel={`Scrub both versions. ${cuts ? `${cuts} ${cuts === 1 ? 'cut is' : 'cuts are'} marked.` : ''}`}
        testID="compare-scrub"
        {...pan.panHandlers}
      >
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <View style={s.bar} />
          {width
            ? spans.map((sp) => <View key={sp.key} style={[s.span, { left: sp.from * width, width: Math.max(3, (sp.to - sp.from) * width) }]} testID="compare-span" />)
            : null}
          {width ? marks.map((m) => <View key={m.key} style={[s.mark, m.tone === 'cut' ? s.markCut : s.markAccent, { left: m.frac * width }]} testID={`compare-mark-${m.tone}`} />) : null}
          {width ? (
            <Animated.View style={[s.playhead, head]}>
              <Animated.View style={[s.knob, knob]} />
            </Animated.View>
          ) : null}
        </View>
      </View>
      <View style={s.labels} pointerEvents="none">
        <Text variant="label" tone="muted">
          0:00
        </Text>
        <Text variant="label" tone="muted">
          Drag to scrub both
        </Text>
        <Text variant="label" tone="muted" tabular>
          {formatDuration(duration)}
        </Text>
      </View>
    </View>
  );
});
