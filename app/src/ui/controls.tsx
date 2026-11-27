import { useEffect, useRef } from 'react';
import { Platform, View } from 'react-native';
import Animated, {
  Easing,
  ReduceMotion,
  cancelAnimation,
  interpolateColor,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
  type EntryExitAnimationFunction,
} from 'react-native-reanimated';
import { prefersReducedMotion, useReducedMotionSetting } from './a11y';
import Svg, { Circle } from 'react-native-svg';
import { size } from './tokens';
import { Text } from './type';
import { PressableScale } from './PressableScale';
import { makeStyles, useColors } from './theme';
import { animateTo, useMotionValue } from './motion';
import { motionConfig, motionHaptics } from './motionPresets';

export { SegmentedControl, type Segment, type SegmentedControlProps } from './SegmentedControl';

/**
 * Native (iOS, Android) controls move on the UI thread: the switch knob and progress fills
 * follow their value with the brief's `select` and `progress` motions. Web keeps the static
 * rendering it always had (the browser end-to-end suite drives it).
 */
const native = Platform.OS !== 'web';

const useStyles = makeStyles((t) => ({
  toggleHit: { minHeight: size.touch, justifyContent: 'center' },
  track: { width: 50, height: 30, borderRadius: 15, padding: 3, justifyContent: 'center' },
  knob: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#FFFFFF' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  stepButton: {
    width: size.touch,
    height: size.touch,
    borderRadius: size.touch / 2,
    borderWidth: 1,
    borderColor: t.color.outline,
    backgroundColor: t.color.fill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepGlyph: { fontSize: 20, lineHeight: 22 },
  stepValue: { width: 28 },
  progressTrack: { backgroundColor: t.color.track, overflow: 'hidden', flexDirection: 'row' },
  stepBar: { flexDirection: 'row', gap: 4 },
  stepPill: { flex: 1, height: 8, borderRadius: 4 },
}));

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

/** 50 x 30 switch from the mock-up, inside a 44pt touch target. The knob moves with `select`. */
export function Toggle({ value, onValueChange, accessibilityLabel, disabled, testID }: ToggleProps) {
  const s = useStyles();
  const c = useColors();
  return (
    <PressableScale
      onPress={() => onValueChange(!value)}
      disabled={disabled}
      motion="chip"
      haptic={motionHaptics.select}
      restingOpacity={disabled ? 0.4 : 1}
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: value, disabled: !!disabled }}
      aria-checked={value}
      testID={testID}
      hitSlop={7}
      style={s.toggleHit}
    >
      {native ? (
        <ToggleTrackNative value={value} />
      ) : (
        <View style={[s.track, { backgroundColor: value ? c.accent : c.toggleOff, alignItems: value ? 'flex-end' : 'flex-start' }]}>
          <View style={s.knob} />
        </View>
      )}
    </PressableScale>
  );
}

function ToggleTrackNative({ value }: { value: boolean }) {
  const s = useStyles();
  const c = useColors();
  const on = useMotionValue(value ? 1 : 0, 'select');
  const track = useAnimatedStyle(() => ({ backgroundColor: interpolateColor(on.value, [0, 1], [c.toggleOff, c.accent]) }), [c]);
  const knob = useAnimatedStyle(() => ({ transform: [{ translateX: on.value * KNOB_TRAVEL }] }));
  return (
    <Animated.View style={[s.track, track]}>
      <Animated.View style={[s.knob, knob]} />
    </Animated.View>
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
  const s = useStyles();
  return (
    <View style={s.stepper} accessibilityRole="adjustable" accessibilityLabel={noun} accessibilityValue={{ min, max, now: value }}>
      <StepButton label={`Fewer ${noun}`} glyph="−" disabled={value <= min} onPress={() => onChange(Math.max(min, value - 1))} />
      {native ? (
        <RollingValue value={value} style={s.stepValue} />
      ) : (
        <Text variant="button" weight={600} style={s.stepValue} center tabular>
          {value}
        </Text>
      )}
      <StepButton label={`More ${noun}`} glyph="+" disabled={value >= max} onPress={() => onChange(Math.min(max, value + 1))} />
    </View>
  );
}

/** A number roll for a discrete change: the new value slides in 8pt from the side it came from and fades in, 200 ms on the UI thread. */
function roll(fromY: number): EntryExitAnimationFunction {
  return () => {
    'worklet';
    const t = { duration: 200, easing: Easing.bezier(0.2, 0.8, 0.2, 1), reduceMotion: ReduceMotion.System };
    return {
      initialValues: { opacity: 0, transform: [{ translateY: fromY }] },
      animations: { opacity: withTiming(1, t), transform: [{ translateY: withTiming(0, t) }] },
    };
  };
}
const rollUp = roll(8);
const rollDown = roll(-8);

/**
 * A changing number that rolls to its new value (brief 4.12: "numeric roll, 200 ms"). Re-keyed
 * per value, so only the digits move; under Reduce Motion it simply changes.
 */
export function RollingValue({ value, style }: { value: number | string; style?: object }) {
  const reduced = useReducedMotionSetting();
  const prev = useRef(value);
  const up = Number(value) >= Number(prev.current);
  const first = prev.current === value;
  useEffect(() => {
    prev.current = value;
  }, [value]);
  return (
    <View style={[{ overflow: 'hidden', alignItems: 'center' }, style]}>
      <Animated.View key={String(value)} entering={first || reduced ? undefined : up ? rollUp : rollDown}>
        <Text variant="button" weight={600} center tabular>
          {value}
        </Text>
      </Animated.View>
    </View>
  );
}

function StepButton({ label, glyph, disabled, onPress }: { label: string; glyph: string; disabled: boolean; onPress: () => void }) {
  const s = useStyles();
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      motion="icon"
      haptic={motionHaptics.select}
      restingOpacity={disabled ? 0.4 : 1}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={s.stepButton}
    >
      <Text variant="body" style={s.stepGlyph}>
        {glyph}
      </Text>
    </PressableScale>
  );
}

// ---- ProgressBar ------------------------------------------------------------

export interface ProgressBarProps {
  /** 0..1 */
  value: number;
  /** 6 on cards, 3 in rows and the preview link. */
  height?: number;
  accessibilityLabel?: string;
  /** `cut` when failed or offline. */
  tone?: 'accent' | 'cut';
}

/**
 * Progress bar (design brief 5.6). On native the fill is full width and scales on X from the
 * left with the `progress` motion (450 ms; a transform, so no layout per frame); it never runs
 * backwards. Web draws the static width.
 */
export function ProgressBar({ value, height = 6, accessibilityLabel, tone = 'accent' }: ProgressBarProps) {
  const s = useStyles();
  const c = useColors();
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  const fill = tone === 'cut' ? c.cut : c.accent;
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min: 0, max: 100, now: pct }}
      style={[s.progressTrack, { height, borderRadius: height / 2 }]}
    >
      {native ? <ProgressFillNative fraction={pct / 100} height={height} fill={fill} /> : <View style={{ width: `${pct}%`, height, borderRadius: height / 2, backgroundColor: fill }} />}
    </View>
  );
}

function ProgressFillNative({ fraction, height, fill }: { fraction: number; height: number; fill: string }) {
  const p = useMotionValue(fraction, 'progress');
  const style = useAnimatedStyle(() => ({ transform: [{ scaleX: p.value }] }));
  return <Animated.View style={[{ flex: 1, height, borderRadius: height / 2, backgroundColor: fill, transformOrigin: 'left' }, style]} />;
}

// ---- ProgressRing -----------------------------------------------------------

export interface ProgressRingProps {
  /** 0..1, or `null` for indeterminate (a 25% arc turning once a second). */
  value: number | null;
  /** 20 (accessory), 28 (rows), 44 (cards and export). */
  size?: 20 | 28 | 44 | number;
  tone?: 'accent' | 'cut';
  accessibilityLabel?: string;
}

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/**
 * Progress ring (design brief 5.6): stroke 3, round caps, `track` behind and an `accent` arc
 * from 12 o'clock clockwise, moving with `progress` (never backwards). Show the number next to
 * it somewhere on screen.
 */
export function ProgressRing({ value, size: d = 28, tone = 'accent', accessibilityLabel }: ProgressRingProps) {
  const c = useColors();
  const stroke = 3;
  const r = (d - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const indeterminate = value === null;
  const fraction = indeterminate ? 0.25 : Math.min(1, Math.max(0, value));
  const p = useMotionValue(fraction, 'progress', { allowBackwards: indeterminate });
  const spin = useSpin(indeterminate);
  const arc = useAnimatedProps(() => ({ strokeDashoffset: circumference * (1 - p.value) }), [circumference]);
  const color = tone === 'cut' ? c.cut : c.accent;
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={indeterminate ? undefined : { min: 0, max: 100, now: Math.round(fraction * 100) }}
      style={{ width: d, height: d }}
    >
      <Animated.View style={[{ width: d, height: d }, spin]}>
        <Svg width={d} height={d}>
          <Circle cx={d / 2} cy={d / 2} r={r} stroke={c.track} strokeWidth={stroke} fill="none" />
          <AnimatedCircle
            cx={d / 2}
            cy={d / 2}
            r={r}
            stroke={color}
            strokeWidth={stroke}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={`${circumference} ${circumference}`}
            animatedProps={arc}
          />
        </Svg>
      </Animated.View>
    </View>
  );
}

/** One linear turn a second while `on`; still under Reduce Motion (the arc alone says "working"). */
function useSpin(on: boolean) {
  const turn = useSharedValue(0);
  const reduced = useReducedMotionSetting();
  useEffect(() => {
    if (!on || reduced || !native) {
      cancelAnimation(turn);
      turn.value = 0;
      return;
    }
    turn.value = 0;
    turn.value = withRepeat(withTiming(1, { duration: 1000, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(turn);
  }, [on, reduced, turn]);
  return useAnimatedStyle(() => ({ transform: [{ rotate: `${-90 + turn.value * 360}deg` }] }));
}

/**
 * One pill per step, filled up to `done` (the weekly goal bar). On native the pills fill step by
 * step (`progress`, 60 ms apart); a lower count shows at once (progress never runs backwards).
 */
export function StepBar({ done, total, accessibilityLabel }: { done: number; total: number; accessibilityLabel: string }) {
  const s = useStyles();
  const c = useColors();
  const steps = Math.max(1, total);
  const prev = useRef(native ? 0 : done);
  const from = prev.current;
  useEffect(() => {
    prev.current = done;
  }, [done]);
  return (
    <View
      style={s.stepBar}
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min: 0, max: steps, now: Math.min(done, steps) }}
    >
      {Array.from({ length: steps }, (_, i) =>
        native ? (
          <StepPill key={i} on={i < done} delay={Math.max(0, i - from) * 60} />
        ) : (
          <View key={i} style={[s.stepPill, { backgroundColor: i < done ? c.accent : c.track }]} />
        ),
      )}
    </View>
  );
}

function StepPill({ on, delay }: { on: boolean; delay: number }) {
  const s = useStyles();
  const c = useColors();
  const fill = useSharedValue(0);
  useEffect(() => {
    if (!on) {
      cancelAnimation(fill);
      fill.value = 0;
      return;
    }
    const reduced = prefersReducedMotion();
    const config = motionConfig('progress', reduced);
    fill.value = withDelay(reduced ? 0 : delay, animateTo(1, config, reduced ? ReduceMotion.Never : ReduceMotion.System));
  }, [on, delay, fill]);
  const style = useAnimatedStyle(() => ({ transform: [{ scaleX: fill.value }] }));
  return (
    <View style={[s.stepPill, { backgroundColor: c.track, overflow: 'hidden' }]}>
      <Animated.View style={[{ flex: 1, backgroundColor: c.accent, transformOrigin: 'left' }, style]} />
    </View>
  );
}
