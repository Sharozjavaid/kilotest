import { memo } from 'react';
import { Platform, View } from 'react-native';
import { PressableScale } from '@/ui/PressableScale';
import { SymbolIcon } from '@/ui/SymbolIcon';
import { motionHaptics } from '@/ui/motionPresets';
import { makeStyles, useColors } from '@/ui/theme';
import { size } from '@/ui/tokens';
import { Text } from '@/ui/type';
import type { CutLine } from './cuts';

const useStyles = makeStyles((t) => ({
  // A capsule inside the glass toolbar: it shares the bar's material (never glass on glass), so it is a faint fill.
  bar: { flexDirection: 'row', alignItems: 'center', height: 48, borderRadius: 24, backgroundColor: t.color.segTrack },
  step: { width: size.touch, height: 48, alignItems: 'center', justifyContent: 'center' },
  label: { minWidth: 56, alignItems: 'center' },
}));

/**
 * "6 cuts" between previous and next (design brief 4.6, in the floating toolbar): steps
 * through only the cut lines, playing each with a moment either side so the creator hears
 * whether it should go; the screen scrolls to the line and flashes its outline. Each half is a
 * 44pt target; a step plays the `selection` haptic.
 */
export const CutStepper = memo(function CutStepper({
  lines,
  current,
  summary,
  onStep,
}: {
  lines: readonly CutLine[];
  /** Segment id of the cut being played, or null. */
  current: string | null;
  /** "6 cuts: 3 filler, …", for screen readers. */
  summary: string;
  onStep: (dir: 1 | -1) => void;
}) {
  const s = useStyles();
  const index = current ? lines.findIndex((l) => l.segmentId === current) : -1;
  const n = lines.length;
  const title = index >= 0 ? `Cut ${index + 1} of ${n}` : n === 1 ? '1 cut' : `${n} cuts`;
  return (
    <View style={s.bar} testID="cut-stepper">
      <StepButton icon="chevronLeft" label="Previous cut" disabled={!n} onPress={() => onStep(-1)} testID="cut-prev" />
      <View style={s.label} accessible accessibilityLabel={index >= 0 ? `${title}: ${lines[index]!.why}` : summary} accessibilityLiveRegion="polite">
        <Text variant="body" weight={600} tone={index >= 0 ? 'cut' : 'ink'} testID="cut-summary" numberOfLines={1} tabular>
          {title}
        </Text>
      </View>
      <StepButton icon="chevronRight" label="Next cut" disabled={!n} onPress={() => onStep(1)} testID="cut-next" />
    </View>
  );
});

function StepButton({ icon, label, disabled, onPress, testID }: { icon: 'chevronLeft' | 'chevronRight'; label: string; disabled: boolean; onPress: () => void; testID: string }) {
  const s = useStyles();
  const c = useColors();
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
      style={s.step}
      testID={testID}
    >
      <SymbolIcon name={icon} size={Platform.OS === 'ios' ? 15 : 18} strokeWidth={2.2} color={c.ink} />
    </PressableScale>
  );
}
