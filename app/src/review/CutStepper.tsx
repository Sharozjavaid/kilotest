import { Pressable, StyleSheet, View } from 'react-native';
import { Icon } from '@/ui/Icon';
import { color, size } from '@/ui/tokens';
import { Text } from '@/ui/type';
import type { CutLine } from './cuts';

/**
 * "6 cuts" between previous and next: steps through only the cut lines, playing each with
 * a moment either side so the creator hears whether it should go; the line itself (why it
 * was cut, Keep both) is scrolled to and highlighted. No timeline: a label and two buttons
 * beside the captions chip.
 */
export function CutStepper({
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
  const index = current ? lines.findIndex((l) => l.segmentId === current) : -1;
  const n = lines.length;
  const title = index >= 0 ? `Cut ${index + 1} of ${n}` : n === 1 ? '1 cut' : `${n} cuts`;
  return (
    <View style={styles.bar} testID="cut-stepper">
      <StepButton icon="chevronLeft" label="Previous cut" disabled={!n} onPress={() => onStep(-1)} testID="cut-prev" />
      <View accessible accessibilityLabel={index >= 0 ? `${title}: ${lines[index]!.why}` : summary} accessibilityLiveRegion="polite">
        <Text variant="secondary" weight={600} tone={index >= 0 ? 'cut' : 'ink'} testID="cut-summary" numberOfLines={1}>
          {title}
        </Text>
      </View>
      <StepButton icon="chevronRight" label="Next cut" disabled={!n} onPress={() => onStep(1)} testID="cut-next" />
    </View>
  );
}

function StepButton({ icon, label, disabled, onPress, testID }: { icon: 'chevronLeft' | 'chevronRight'; label: string; disabled: boolean; onPress: () => void; testID: string }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.step, disabled && { opacity: 0.4 }, pressed && { opacity: 0.6 }]}
      testID={testID}
    >
      <Icon name={icon} size={18} color={color.ink} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    borderRadius: size.touch / 2,
    borderWidth: 1,
    borderColor: color.hairline,
    backgroundColor: color.surfaceStrong,
  },
  step: { width: size.touch, height: size.touch, borderRadius: size.touch / 2, alignItems: 'center', justifyContent: 'center' },
});
