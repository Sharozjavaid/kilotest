import { View } from 'react-native';
import { Header, IconButton } from './layout';
import { ActionMenu } from './ActionMenu';
import type { ScreenHeaderConfig, ScreenHeaderResult } from './ScreenHeader.types';

export type { HeaderAction, ScreenHeaderConfig, ScreenHeaderResult } from './ScreenHeader.types';

/** Android and web: the in-content `Header` row, with actions as round icon buttons (menus as Kilo's popover). */
export function useScreenHeader(header: ScreenHeaderConfig | undefined): ScreenHeaderResult {
  if (!header) return { native: false, element: null };
  const actions = header.actions?.length ? (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      {header.actions.map((a) =>
        a.menu?.length ? (
          <ActionMenu key={a.label} icon={a.icon} label={a.label} items={a.menu} testID={a.testID} />
        ) : (
          <IconButton key={a.label} icon={a.icon} label={a.label} onPress={a.onPress} disabled={a.disabled} testID={a.testID} />
        ),
      )}
    </View>
  ) : null;
  return {
    native: false,
    element: <Header title={header.title} meta={header.meta} right={header.right ?? actions ?? undefined} onBack={header.onBack} noBack={header.noBack} size={header.size} />,
  };
}
