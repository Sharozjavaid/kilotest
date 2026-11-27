import { useEffect, useState } from 'react';
import { Platform, StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { interpolateColor, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { color, radius, size } from './tokens';
import { Text } from './type';
import { PressableScale } from './PressableScale';
import { prefersReducedMotion } from './a11y';
import { animateTo } from './motion';
import { motionConfig } from './motionPresets';

/**
 * Native (iOS, Android) controls move on the UI thread: the switch knob, the segmented
 * control's selection and progress fills spring to their new place. Web keeps the static
 * rendering it always had (the browser end-to-end suite drives it).
 */
const native = Platform.OS !== 'web';

/** Animates a shared value to `target` with a named preset whenever `target` changes (skips the first render). */
function useAnimatedTarget(target: number, preset: 'select' | 'progress') {
  const v = useSharedValue(target);
  useEffect(() => {
    v.value = animateTo(target, motionConfig(preset, prefersReducedMotion()));
  }, [target, preset, v]);
  return v;
}

// ---- Toggle -----------------------------------------------------------------

export interface ToggleProps {
  value: boolean;
  onValueChange: (next: boolean) => void;
  /** Spoken name of the switch. Required: the visible label sits outside it. */
  accessibilityLabel: string;
  disabled?: boolean;
  testID?: string;
}

const KNOB_TRAVEL = 50 - 24 - 3 * 2;

/** 50 x 30 switch from the mock-up, inside a 44pt touch target. */
export function Toggle({ value, onValueChange, accessibilityLabel, disabled, testID }: ToggleProps) {
  return (
    <PressableScale
      onPress={() => onValueChange(!value)}
      disabled={disabled}
      motion="chip"
      haptic="selection"
      restingOpacity={disabled ? 0.4 : 1}
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: value, disabled: !!disabled }}
      aria-checked={value}
      testID={testID}
      hitSlop={7}
      style={styles.toggleHit}
    >
      {native ? (
        <ToggleTrackNative value={value} />
      ) : (
        <View style={[styles.track, { backgroundColor: value ? color.accent : color.toggleOff, alignItems: value ? 'flex-end' : 'flex-start' }]}>
          <View style={styles.knob} />
        </View>
      )}
    </PressableScale>
  );
}

function ToggleTrackNative({ value }: { value: boolean }) {
  const on = useAnimatedTarget(value ? 1 : 0, 'select');
  const track = useAnimatedStyle(() => ({ backgroundColor: interpolateColor(on.value, [0, 1], [color.toggleOff, color.accent]) }));
  const knob = useAnimatedStyle(() => ({ transform: [{ translateX: on.value * KNOB_TRAVEL }] }));
  return (
    <Animated.View style={[styles.track, track]}>
      <Animated.View style={[styles.knob, knob]} />
    </Animated.View>
  );
}

// ---- SegmentedControl -------------------------------------------------------

export interface Segment<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedControlProps<T extends string> {
  segments: readonly Segment<T>[];
  value: T;
  onChange: (value: T) => void;
  accessibilityLabel: string;
  style?: StyleProp<ViewStyle>;
}

const SEG_PAD = 4;
const SEG_GAP = 4;

/** Ink-filled selected segment on a glass track (mock-up "Kind of video"). On native the ink slides between segments. */
export function SegmentedControl<T extends string>({ segments, value, onChange, accessibilityLabel, style }: SegmentedControlProps<T>) {
  const index = Math.max(0, segments.findIndex((s) => s.value === value));
  return (
    <View style={[styles.segTrack, style]} accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel}>
      {native ? <SegmentIndicator index={index} count={segments.length} /> : null}
      {segments.map((s) => {
        const selected = s.value === value;
        return (
          <PressableScale
            key={s.value}
            onPress={() => onChange(s.value)}
            motion="chip"
            haptic={selected ? false : 'selection'}
            accessibilityRole="radio"
            accessibilityLabel={s.label}
            accessibilityState={{ selected, checked: selected }}
            // react-native-web does not turn accessibilityState into aria-checked; say it directly.
            aria-checked={selected}
            style={[styles.seg, selected && !native && styles.segSelected]}
          >
            <Text variant="body" weight={selected ? 600 : 500} tone={selected ? 'white' : 'muted'} style={styles.segText} numberOfLines={1}>
              {s.label}
            </Text>
          </PressableScale>
        );
      })}
    </View>
  );
}

/** The sliding ink pill behind the selected segment. Measures the track once per size change. */
function SegmentIndicator({ index, count }: { index: number; count: number }) {
  const [trackWidth, setTrackWidth] = useState(0);
  const pos = useAnimatedTarget(index, 'select');
  const segWidth = count > 0 && trackWidth > 0 ? (trackWidth - SEG_PAD * 2 - SEG_GAP * (count - 1)) / count : 0;
  const slide = useAnimatedStyle(() => ({ transform: [{ translateX: pos.value * (segWidth + SEG_GAP) }] }), [segWidth]);
  const onLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (Math.abs(w - trackWidth) > 0.5) setTrackWidth(w);
  };
  return (
    <View style={StyleSheet.absoluteFill} onLayout={onLayout} pointerEvents="none">
      {segWidth > 0 ? <Animated.View style={[styles.segIndicator, { width: segWidth }, slide]} /> : null}
    </View>
  );
}

// ---- Stepper ----------------------------------------------------------------

export interface StepperProps {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  /** e.g. "variations": buttons read "Fewer variations" / "More variations". */
  noun: string;
}

export function Stepper({ value, min, max, onChange, noun }: StepperProps) {
  return (
    <View style={styles.stepper} accessibilityRole="adjustable" accessibilityLabel={noun} accessibilityValue={{ min, max, now: value }}>
      <StepButton label={`Fewer ${noun}`} glyph="−" disabled={value <= min} onPress={() => onChange(Math.max(min, value - 1))} />
      <Text variant="button" weight={600} style={styles.stepValue} center>
        {value}
      </Text>
      <StepButton label={`More ${noun}`} glyph="+" disabled={value >= max} onPress={() => onChange(Math.min(max, value + 1))} />
    </View>
  );
}

function StepButton({ label, glyph, disabled, onPress }: { label: string; glyph: string; disabled: boolean; onPress: () => void }) {
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      motion="icon"
      haptic="selection"
      restingOpacity={disabled ? 0.4 : 1}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={styles.stepButton}
    >
      <Text variant="body" style={styles.stepGlyph}>
        {glyph}
      </Text>
    </PressableScale>
  );
}

// ---- ProgressBar ------------------------------------------------------------

export interface ProgressBarProps {
  /** 0..1 */
  value: number;
  height?: number;
  accessibilityLabel?: string;
  tone?: 'accent' | 'cut';
}

export function ProgressBar({ value, height = 6, accessibilityLabel, tone = 'accent' }: ProgressBarProps) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  const fill = tone === 'cut' ? color.cut : color.accent;
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min: 0, max: 100, now: pct }}
      style={[styles.progressTrack, { height, borderRadius: height / 2 }]}
    >
      {native ? (
        <ProgressFillNative pct={pct} height={height} fill={fill} />
      ) : (
        <View style={{ width: `${pct}%`, height, borderRadius: height / 2, backgroundColor: fill }} />
      )}
    </View>
  );
}

/**
 * A full-width fill slid left by the missing share: moving it is a transform (no layout per
 * frame), and its rounded right end stays round at any value.
 */
function ProgressFillNative({ pct, height, fill }: { pct: number; height: number; fill: string }) {
  const [width, setWidth] = useState(0);
  const p = useAnimatedTarget(pct / 100, 'progress');
  const slide = useAnimatedStyle(() => ({ transform: [{ translateX: (p.value - 1) * width }] }), [width]);
  return (
    <View
      style={StyleSheet.absoluteFill}
      onLayout={(e) => {
        const w = e.nativeEvent.layout.width;
        if (Math.abs(w - width) > 0.5) setWidth(w);
      }}
    >
      {width > 0 ? (
        <Animated.View style={[{ width, height, borderRadius: height / 2, backgroundColor: fill }, slide]} />
      ) : (
        // Until the track is measured: the static fill, so the first frame is not empty.
        <View style={{ width: `${pct}%`, height, borderRadius: height / 2, backgroundColor: fill }} />
      )}
    </View>
  );
}

/** One pill per step, filled up to `done` (the weekly goal bar). */
export function StepBar({ done, total, accessibilityLabel }: { done: number; total: number; accessibilityLabel: string }) {
  const steps = Math.max(1, total);
  return (
    <View
      style={styles.stepBar}
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min: 0, max: steps, now: Math.min(done, steps) }}
    >
      {Array.from({ length: steps }, (_, i) => (
        <View key={i} style={[styles.stepPill, { backgroundColor: i < done ? color.accent : color.track }]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  toggleHit: { minHeight: size.touch, justifyContent: 'center' },
  track: { width: 50, height: 30, borderRadius: 15, padding: 3, justifyContent: 'center' },
  knob: { width: 24, height: 24, borderRadius: 12, backgroundColor: color.white },
  segTrack: {
    flexDirection: 'row',
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.lg,
    padding: SEG_PAD,
    gap: SEG_GAP,
  },
  seg: { flex: 1, height: size.touch, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  segSelected: { backgroundColor: color.ink },
  segIndicator: { position: 'absolute', top: SEG_PAD, left: SEG_PAD, height: size.touch, borderRadius: radius.md, backgroundColor: color.ink },
  segText: { fontSize: 14 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  stepButton: {
    width: size.touch,
    height: size.touch,
    borderRadius: size.touch / 2,
    borderWidth: 1,
    borderColor: color.outline,
    backgroundColor: color.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepGlyph: { fontSize: 20, lineHeight: 22 },
  stepValue: { width: 28 },
  progressTrack: { backgroundColor: color.track, overflow: 'hidden', flexDirection: 'row' },
  stepBar: { flexDirection: 'row', gap: 6 },
  stepPill: { flex: 1, height: 8, borderRadius: 4 },
});
