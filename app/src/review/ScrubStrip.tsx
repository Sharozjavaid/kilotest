import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, Platform, StyleSheet, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import Animated, { Easing, ReduceMotion, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming, type SharedValue } from 'react-native-reanimated';
import type { Edl } from '@kilo/edl';
import { formatDuration } from '@/lib/format';
import { easings, springs, timings } from '@/ui/motionPresets';
import { makeStyles } from '@/ui/theme';
import { Text } from '@/ui/type';
import { layoutStrip, proxyToX, xToTarget, type ScrubTarget } from './scrub';

const native = Platform.OS !== 'web';
const standard = Easing.bezier(easings.standard[0], easings.standard[1], easings.standard[2], easings.standard[3]);
const KNOB = 10;
const KNOB_DRAG = 14;

const useStyles = makeStyles((t) => ({
  strip: { height: 36, position: 'relative' },
  block: { position: 'absolute', top: 4, height: 28, borderRadius: 5 },
  kept: { backgroundColor: t.color.accent },
  cut: { backgroundColor: t.scheme === 'dark' ? 'transparent' : t.color.fill, borderWidth: 1, borderColor: t.color.cut },
  /** Overlay marker: a dot with an ink ring on the block's top edge. */
  marker: { position: 'absolute', top: 1, width: 7, height: 7, borderRadius: 4, backgroundColor: t.color.fill, borderWidth: 1.5, borderColor: t.color.ink },
  playhead: { position: 'absolute', top: 0, left: 0, width: 2, height: 36, marginLeft: -1, borderRadius: 1, backgroundColor: t.color.ink, alignItems: 'center' },
  knob: { position: 'absolute', top: -KNOB_DRAG / 2, left: 1 - KNOB_DRAG / 2, width: KNOB_DRAG, height: KNOB_DRAG, borderRadius: KNOB_DRAG / 2, backgroundColor: t.color.ink },
  labels: { flexDirection: 'row', justifyContent: 'space-between' },
}));

/**
 * The scrub strip (design brief 4.6): one block per segment (kept: solid accent; cut: white
 * with the cut outline), overlay dots, and a 2pt playhead with a 10pt knob that grows to 14
 * while dragging. Drag to scrub. Content, never glass.
 *
 * The playhead follows `time`, the player's proxy time as a shared value written every frame,
 * and is placed on the UI thread (`proxyToX` is a worklet), so it moves every frame without
 * React re-rendering the screen. The block of the line just tapped (`pulse`)
 * cross-fades from its old fill (160 ms). Mapping lives in scrub.ts.
 */
export const ScrubStrip = memo(function ScrubStrip({
  edl,
  clipOffsets,
  proxyTime,
  segmentId,
  time,
  totalSec,
  onScrub,
  onScrubEnd,
  marked,
  pulse,
}: {
  edl: Edl;
  /** Segments that carry an overlay (B-roll or a graphic): a small marker sits on their block. */
  marked?: ReadonlySet<string>;
  clipOffsets: Record<string, number>;
  proxyTime: number;
  segmentId: string | null;
  /** Proxy time under the playhead, every frame. `proxyTime` is the same, as React state (for screen readers). */
  time: SharedValue<number>;
  totalSec: number;
  onScrub: (t: ScrubTarget) => void;
  onScrubEnd: (t: ScrubTarget | null) => void;
  /** The segment just toggled, with a nonce. */
  pulse?: { id: string; n: number } | null;
}) {
  const s = useStyles();
  const [width, setWidth] = useState(0);
  const layout = useMemo(() => layoutStrip(edl, clipOffsets, width), [edl, clipOffsets, width]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const last = useRef<ScrubTarget | null>(null);
  const cb = useRef({ onScrub, onScrubEnd });
  cb.current = { onScrub, onScrubEnd };
  const dragging = useSharedValue(0);

  const pan = useMemo(() => {
    const at = (e: GestureResponderEvent) => {
      const t = xToTarget(layoutRef.current, e.nativeEvent.locationX);
      if (t) {
        last.current = t;
        cb.current.onScrub(t);
      }
    };
    const end = () => {
      dragging.value = withSpring(0, { ...springs.select, reduceMotion: ReduceMotion.System });
      cb.current.onScrubEnd(last.current);
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
    const x = width ? Math.max(1, Math.min(width - 1, proxyToX(layout, time.value, segmentId))) : 0;
    return { transform: [{ translateX: x }] };
  }, [layout, segmentId, width]);
  // Drawn at the dragging size and scaled down at rest: a transform, never a layout change.
  const knob = useAnimatedStyle(() => ({ transform: [{ scale: (KNOB + (KNOB_DRAG - KNOB) * dragging.value) / KNOB_DRAG }] }));
  const pulsed = pulse && native ? layout.blocks.find((b) => b.segmentId === pulse.id) : undefined;

  return (
    <View style={{ gap: 6 }}>
      <View
        style={s.strip}
        onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
        accessibilityRole="adjustable"
        accessibilityLabel="Scrub strip. Blue blocks are kept, outlined blocks are cut."
        accessibilityValue={{ text: formatDuration(proxyTime) }}
        testID="scrub-strip"
        {...pan.panHandlers}
      >
        {/* Children must not take the touch, so locationX is relative to the strip. */}
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          {layout.blocks.map((b) => (
            <View key={b.segmentId} style={[s.block, { left: b.x, width: Math.max(1, b.width) }, b.keep ? s.kept : s.cut]} />
          ))}
          {pulsed ? <BlockFade key={pulse!.n} left={pulsed.x} width={Math.max(1, pulsed.width)} wasKept={!pulsed.keep} /> : null}
          {marked
            ? layout.blocks
                .filter((b) => marked.has(b.segmentId))
                .map((b) => <View key={`m-${b.segmentId}`} style={[s.marker, { left: b.x + Math.min(4, Math.max(0, b.width / 2 - 3)) }]} testID={`marker-${b.segmentId}`} />)
            : null}
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
          Drag to scrub
        </Text>
        <Text variant="label" tone="muted" tabular>
          {formatDuration(totalSec)}
        </Text>
      </View>
    </View>
  );
});

function BlockFade({ left, width, wasKept }: { left: number; width: number; wasKept: boolean }) {
  const s = useStyles();
  const o = useSharedValue(1);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    o.value = withTiming(0, { duration: timings.cutFill.duration, easing: standard, reduceMotion: ReduceMotion.Never }, (f) => {
      if (f) runOnJS(setGone)(true);
    });
  }, [o]);
  const style = useAnimatedStyle(() => ({ opacity: o.value }));
  if (gone) return null;
  return <Animated.View style={[s.block, { left, width }, wasKept ? s.kept : s.cut, style]} />;
}
