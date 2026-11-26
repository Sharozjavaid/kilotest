import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { color, radius, size } from './tokens';
import { Text } from './type';

// ---- Toggle -----------------------------------------------------------------

export interface ToggleProps {
  value: boolean;
  onValueChange: (next: boolean) => void;
  /** Spoken name of the switch. Required: the visible label sits outside it. */
  accessibilityLabel: string;
  disabled?: boolean;
  testID?: string;
}

/** 50 x 30 switch from the mock-up, inside a 44pt touch target. */
export function Toggle({ value, onValueChange, accessibilityLabel, disabled, testID }: ToggleProps) {
  return (
    <Pressable
      onPress={() => onValueChange(!value)}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: value, disabled: !!disabled }}
      aria-checked={value}
      testID={testID}
      hitSlop={7}
      style={[styles.toggleHit, disabled && styles.disabled]}
    >
      <View style={[styles.track, { backgroundColor: value ? color.accent : color.toggleOff, alignItems: value ? 'flex-end' : 'flex-start' }]}>
        <View style={styles.knob} />
      </View>
    </Pressable>
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

/** Ink-filled selected segment on a glass track (mock-up "Kind of video"). */
export function SegmentedControl<T extends string>({ segments, value, onChange, accessibilityLabel, style }: SegmentedControlProps<T>) {
  return (
    <View style={[styles.segTrack, style]} accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel}>
      {segments.map((s) => {
        const selected = s.value === value;
        return (
          <Pressable
            key={s.value}
            onPress={() => onChange(s.value)}
            accessibilityRole="radio"
            accessibilityLabel={s.label}
            accessibilityState={{ selected, checked: selected }}
            // react-native-web does not turn accessibilityState into aria-checked; say it directly.
            aria-checked={selected}
            style={[styles.seg, selected && styles.segSelected]}
          >
            <Text variant="body" weight={selected ? 600 : 500} tone={selected ? 'white' : 'muted'} style={styles.segText} numberOfLines={1}>
              {s.label}
            </Text>
          </Pressable>
        );
      })}
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
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.stepButton, disabled && styles.disabled, pressed && styles.pressed]}
    >
      <Text variant="body" style={styles.stepGlyph}>
        {glyph}
      </Text>
    </Pressable>
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
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min: 0, max: 100, now: pct }}
      style={[styles.progressTrack, { height, borderRadius: height / 2 }]}
    >
      <View
        style={{
          width: `${pct}%`,
          height,
          borderRadius: height / 2,
          backgroundColor: tone === 'cut' ? color.cut : color.accent,
        }}
      />
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
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
  segTrack: {
    flexDirection: 'row',
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.lg,
    padding: 4,
    gap: 4,
  },
  seg: { flex: 1, height: size.touch, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  segSelected: { backgroundColor: color.ink },
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
