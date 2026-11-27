import { memo, useEffect, useRef } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  ReduceMotion,
  scrollTo,
  useAnimatedRef,
  useFrameCallback,
  useSharedValue,
  withTiming,
  type EntryExitAnimationFunction,
} from 'react-native-reanimated';
import { Glass } from '@/ui/Glass';
import { useReducedMotionSetting } from '@/ui/a11y';
import { ThemeScope, useColors } from '@/ui/theme';
import { fontFamily } from '@/ui/tokens';
import { Text } from '@/ui/type';
import type { RecorderPrefs } from './session';
import { teleprompterOffset } from './recordButton';

/** Teleprompter type sizes (brief 4.14: 24, 28 or 34 for the current line; next line 17). */
export const TEXT_SIZES: Record<RecorderPrefs['textSize'], { line: number; next: number }> = {
  S: { line: 24, next: 15 },
  M: { line: 28, next: 17 },
  L: { line: 34, next: 19 },
};
/** Auto-scroll speeds, pt per second. */
export const SCROLL_PX: Record<RecorderPrefs['scrollSpeed'], number> = { 0: 0, 1: 14, 2: 24, 3: 36 };

const native = Platform.OS !== 'web';
const standard = Easing.bezier(0.2, 0.8, 0.2, 1);
const exit = Easing.bezier(0.4, 0, 1, 1);

// The line arrives sliding up 8pt and fading in, 180 ms; the old one leaves the same way.
function lineIn(reduced: boolean): EntryExitAnimationFunction {
  return () => {
    'worklet';
    const t = { duration: 180, easing: standard, reduceMotion: ReduceMotion.Never };
    return reduced
      ? { initialValues: { opacity: 0 }, animations: { opacity: withTiming(1, t) } }
      : { initialValues: { opacity: 0, transform: [{ translateY: 8 }] }, animations: { opacity: withTiming(1, t), transform: [{ translateY: withTiming(0, t) }] } };
  };
}
function lineOut(reduced: boolean): EntryExitAnimationFunction {
  return () => {
    'worklet';
    const t = { duration: 180, easing: exit, reduceMotion: ReduceMotion.Never };
    return reduced
      ? { initialValues: { opacity: 1 }, animations: { opacity: withTiming(0, t) } }
      : { initialValues: { opacity: 1, transform: [{ translateY: 0 }] }, animations: { opacity: withTiming(0, t), transform: [{ translateY: withTiming(-8, t) }] } };
  };
}
const motions = { full: { in: lineIn(false), out: lineOut(false) }, reduced: { in: lineIn(true), out: lineOut(true) } };

/**
 * The teleprompter (design brief 4.14): a light glass panel near the lens, readable over any
 * picture, with "LINE 3 OF 6", the line to say (Inter 600, 24 / 28 / 34) and the next one,
 * dimmed. While recording, a long line scrolls on the UI thread (a frame callback driving
 * `scrollTo`) after holding still for 1.2 s. A new line slides up into place.
 */
export const Teleprompter = memo(function Teleprompter({
  label,
  lineKey,
  lineText,
  nextText,
  textSize,
  scrollSpeed,
  recording,
}: {
  label: string;
  lineKey: string;
  lineText: string;
  nextText?: string;
  textSize: RecorderPrefs['textSize'];
  scrollSpeed: RecorderPrefs['scrollSpeed'];
  recording: boolean;
}) {
  const sizes = TEXT_SIZES[textSize];
  const reduced = useReducedMotionSetting();
  const m = reduced ? motions.reduced : motions.full;
  return (
    <ThemeScope appearance="light">
      <Glass kind="panel" appearance="light" radius={28} style={styles.panel} testID="teleprompter">
        {/* White at 0.55 over the glass: Kilo's look, and ink stays readable over any background. */}
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.veil]} />
        <Text variant="label" weight={600} tone="accent" style={styles.label} testID="line-label">
          {label}
        </Text>
        <Animated.View key={lineKey} entering={native ? m.in : undefined} exiting={native ? m.out : undefined} style={{ gap: 10 }}>
          <LineScroller text={lineText} size={sizes.line} speed={SCROLL_PX[scrollSpeed]} recording={recording} />
          <NextLine text={nextText} size={sizes.next} />
        </Animated.View>
      </Glass>
    </ThemeScope>
  );
});

function LineScroller({ text, size, speed, recording }: { text: string; size: number; speed: number; recording: boolean }) {
  const c = useColors();
  const ref = useAnimatedRef<Animated.ScrollView>();
  const lineHeight = Math.round(size * 1.22);
  const visible = lineHeight * 4;
  const started = useSharedValue(-1);
  const contentH = useRef(0);
  const max = useSharedValue(0);
  const pxPerSec = useSharedValue(speed);
  const frame = useFrameCallback((f) => {
    'worklet';
    if (started.value < 0) started.value = f.timestamp;
    scrollTo(ref, 0, teleprompterOffset(f.timestamp - started.value, pxPerSec.value, max.value), false);
  }, false);
  useEffect(() => {
    started.value = -1;
    pxPerSec.value = speed;
    if (native) scrollTo(ref, 0, 0, false);
    frame.setActive(recording && speed > 0);
    return () => frame.setActive(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, speed, text]);
  return (
    <Animated.ScrollView
      ref={ref}
      style={{ maxHeight: visible }}
      scrollEnabled={!recording || !speed}
      showsVerticalScrollIndicator={false}
      onLayout={(e) => (max.value = Math.max(0, contentH.current - e.nativeEvent.layout.height))}
      onContentSizeChange={(_, h) => {
        contentH.current = h;
        max.value = Math.max(0, h - visible);
      }}
    >
      <Text style={{ fontFamily: fontFamily[600], fontSize: size, lineHeight, letterSpacing: -0.4, color: c.ink }} maxFontSizeMultiplier={1.6} testID="current-line">
        {text}
      </Text>
    </Animated.ScrollView>
  );
}

function NextLine({ text, size }: { text?: string; size: number }) {
  const c = useColors();
  const style = { fontFamily: fontFamily[400], fontSize: size, lineHeight: Math.round(size * 1.3), color: c.muted };
  return (
    <Text style={style} numberOfLines={2} maxFontSizeMultiplier={1.6}>
      {text ? `Next: ${text}` : 'Last line'}
    </Text>
  );
}

const styles = StyleSheet.create({
  panel: { marginHorizontal: 16, paddingVertical: 18, paddingHorizontal: 20, gap: 10 },
  veil: { borderRadius: 28, backgroundColor: 'rgba(255,255,255,0.55)' },
  label: { letterSpacing: 0.5 },
});
