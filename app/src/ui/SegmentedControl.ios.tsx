import { Host, Picker, Text } from '@expo/ui/swift-ui';
import { pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';
import { useTheme } from './theme';
import type { SegmentedControlProps } from './SegmentedControl.types';

export type { Segment, SegmentedControlProps } from './SegmentedControl.types';

/**
 * iOS: the native SwiftUI segmented picker (`@expo/ui`), with the system's own styling, glass
 * on iOS 26 and its own selection haptic (so Kilo plays none). Same props as Kilo's control
 * on Android and web (`SegmentedControl.tsx`).
 */
export function SegmentedControl<T extends string>({ segments, value, onChange, accessibilityLabel, style }: SegmentedControlProps<T>) {
  const theme = useTheme();
  return (
    <Host matchContents={{ vertical: true }} colorScheme={theme.scheme} style={[{ minHeight: 32, alignSelf: 'stretch' }, style]}>
      <Picker<string> label={accessibilityLabel} selection={value} onSelectionChange={(v) => onChange(v as T)} modifiers={[pickerStyle('segmented')]}>
        {segments.map((s) => (
          <Text key={s.value} modifiers={[tag(s.value)]}>
            {s.label}
          </Text>
        ))}
      </Picker>
    </Host>
  );
}
