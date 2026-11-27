import { Host, Picker, Text } from '@expo/ui/swift-ui';
import { pickerStyle, tag, tint } from '@expo/ui/swift-ui/modifiers';
import { useTheme } from '@/ui';
import type { StyleMenuProps } from './StyleMenu.types';

export type { StyleMenuProps } from './StyleMenu.types';

const CUSTOM = '__custom__';

/**
 * iOS: the style row's value as a native pop-up menu (SwiftUI `Picker`, menu style): the current
 * style's name with the system chevrons; tap for a native menu of the saved styles (design brief
 * 4.4). "Custom" while the settings match none of them.
 */
export function StyleMenu({ styles, currentId, onPick }: StyleMenuProps) {
  const theme = useTheme();
  return (
    <Host matchContents colorScheme={theme.scheme}>
      <Picker<string>
        label="Style"
        selection={currentId ?? CUSTOM}
        onSelectionChange={(id) => {
          if (id && id !== CUSTOM) onPick(id);
        }}
        modifiers={[pickerStyle('menu'), tint(theme.color.accent)]}
      >
        {[
          ...(currentId ? [] : [<Text key={CUSTOM} modifiers={[tag(CUSTOM)]}>Custom</Text>]),
          ...styles.map((s) => (
            <Text key={s.id} modifiers={[tag(s.id)]}>
              {s.isDefault ? `${s.name} (default)` : s.name}
            </Text>
          )),
        ]}
      </Picker>
    </Host>
  );
}
