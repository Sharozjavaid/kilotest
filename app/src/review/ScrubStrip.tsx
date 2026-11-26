import { useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import type { Edl } from '@kilo/edl';
import { formatDuration } from '@/lib/format';
import { color } from '@/ui/tokens';
import { Text } from '@/ui/type';
import { layoutStrip, proxyToX, xToTarget, type ScrubTarget } from './scrub';

/**
 * One block per segment (kept: solid accent; cut: white with the cut outline), a
 * playhead, and drag-to-scrub. Mapping lives in scrub.ts.
 */
export function ScrubStrip({
  edl,
  clipOffsets,
  proxyTime,
  segmentId,
  totalSec,
  onScrub,
  onScrubEnd,
}: {
  edl: Edl;
  clipOffsets: Record<string, number>;
  proxyTime: number;
  segmentId: string | null;
  totalSec: number;
  onScrub: (t: ScrubTarget) => void;
  onScrubEnd: (t: ScrubTarget | null) => void;
}) {
  const [width, setWidth] = useState(0);
  const layout = useMemo(() => layoutStrip(edl, clipOffsets, width), [edl, clipOffsets, width]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const last = useRef<ScrubTarget | null>(null);
  const cb = useRef({ onScrub, onScrubEnd });
  cb.current = { onScrub, onScrubEnd };

  const pan = useMemo(() => {
    const at = (e: GestureResponderEvent) => {
      const t = xToTarget(layoutRef.current, e.nativeEvent.locationX);
      if (t) {
        last.current = t;
        cb.current.onScrub(t);
      }
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: at,
      onPanResponderMove: at,
      onPanResponderRelease: () => cb.current.onScrubEnd(last.current),
      onPanResponderTerminate: () => cb.current.onScrubEnd(last.current),
    });
  }, []);

  const playheadX = width ? proxyToX(layout, proxyTime, segmentId) : 0;

  return (
    <View style={{ gap: 6 }}>
      <View
        style={styles.strip}
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
            <View
              key={b.segmentId}
              style={[styles.block, { left: b.x, width: Math.max(1, b.width) }, b.keep ? styles.kept : styles.cut]}
            />
          ))}
          {width ? <View style={[styles.playhead, { left: Math.max(0, Math.min(width - 3, playheadX - 1.5)) }]} /> : null}
        </View>
      </View>
      <View style={styles.labels} pointerEvents="none">
        <Text variant="label" tone="muted">
          0:00
        </Text>
        <Text variant="label" tone="muted">
          Drag to scrub
        </Text>
        <Text variant="label" tone="muted">
          {formatDuration(totalSec)}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { height: 36, position: 'relative' },
  block: { position: 'absolute', top: 4, height: 28, borderRadius: 5 },
  kept: { backgroundColor: color.accent },
  cut: { backgroundColor: color.white, borderWidth: 1, borderColor: color.cut },
  playhead: { position: 'absolute', top: 0, width: 3, height: 36, borderRadius: 2, backgroundColor: color.ink },
  labels: { flexDirection: 'row', justifyContent: 'space-between' },
});
