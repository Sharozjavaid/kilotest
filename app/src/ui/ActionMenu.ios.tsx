import { Button, Host, Label, Menu, Text } from '@expo/ui/swift-ui';
import { buttonStyle, controlSize, disabled, labelStyle, tint } from '@expo/ui/swift-ui/modifiers';
import { sfSymbolFor } from './symbols';
import { hasLiquidGlass } from './glass';
import { size } from './tokens';
import { useTheme } from './theme';
import type { ActionMenuProps } from './ActionMenu.types';

export type { ActionMenuProps, MenuItem } from './ActionMenu.types';

/**
 * iOS: a native SwiftUI `Menu` (`@expo/ui`) behind a glass icon button. On iOS 26 the menu
 * morphs out of the glass button; before that it is the standard context menu and the button
 * is bordered. Each item is a native button with its symbol, label and one-line subtitle.
 */
export function ActionMenu({ icon, label, items, title, testID }: ActionMenuProps) {
  const theme = useTheme();
  const glass = hasLiquidGlass();
  return (
    <Host matchContents colorScheme={theme.scheme} style={{ minWidth: size.touch, minHeight: size.touch }} testID={testID}>
      <Menu
        label={label}
        systemImage={sfSymbolFor(icon)}
        modifiers={[buttonStyle(glass ? 'glass' : 'bordered'), labelStyle('iconOnly'), controlSize('large'), tint(theme.color.ink)]}
      >
        {title ? <Text>{title}</Text> : null}
        {items.map((it) => (
          <Button key={it.label} onPress={it.onPress} role={it.destructive ? 'destructive' : 'default'} modifiers={it.disabled ? [disabled(true)] : undefined}>
            {[
              <Label key="l" title={it.label} systemImage={it.sf ?? (it.icon ? sfSymbolFor(it.icon) : undefined)} />,
              ...(it.subtitle ? [<Text key="s">{it.subtitle}</Text>] : []),
            ]}
          </Button>
        ))}
      </Menu>
    </Host>
  );
}
