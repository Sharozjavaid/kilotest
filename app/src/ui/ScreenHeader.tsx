import { View } from 'react-native';
import { Header } from './layout';
import { IconButton } from './layout';
import type { ScreenHeaderConfig, ScreenHeaderResult } from './ScreenHeader.types';

export type { HeaderAction, ScreenHeaderConfig, ScreenHeaderResult } from './ScreenHeader.types';

/** Android and web: the in-content `Header` row, with actions as round icon buttons. */
export function useScreenHeader(header: ScreenHeaderConfig | undefined): ScreenHeaderResult {
  if (!header) return { native: false, element: null };
  const actions = header.actions?.length ? (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      {header.actions.map((a) => (
        <IconButton key={a.label} icon={a.icon} label={a.label} onPress={a.onPress} disabled={a.disabled} />
      ))}
    </View>
  ) : null;
  return {
    native: false,
    element: <Header title={header.title} meta={header.meta} right={header.right ?? actions ?? undefined} onBack={header.onBack} noBack={header.noBack} size={header.size} />,
  };
}
