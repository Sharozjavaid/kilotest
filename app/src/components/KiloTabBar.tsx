import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { size } from '@/ui/tokens';
import { themeFor, useSystemScheme } from '@/ui/theme';
import { Icon, type IconName } from '@/ui/Icon';
import { Text } from '@/ui/type';

/** The parts of the navigator's tab bar props this bar uses. */
interface TabBarProps {
  state: { index: number; routes: Array<{ key: string; name: string }> };
  emitter: { emit: (e: { type: 'tabPress'; target: string; canPreventDefault: true }) => { defaultPrevented: boolean } };
  navigateToTab: (routeKey: string) => void;
}

/** By tab group (each tab is a group with its own stack). */
const TABS: Record<string, { label: string; icon: IconName }> = {
  '(home)': { label: 'Videos', icon: 'videos' },
  '(styles)': { label: 'Styles', icon: 'styles' },
  '(you)': { label: 'You', icon: 'user' },
};

/**
 * 72pt glass tab bar from the mock-up: icon over a 12pt label, accent when active. Web only
 * (iOS and Android use the native tab bar). Follows the system appearance, as the tab screens
 * do; the uploads capsule floats above it (`TabStack`).
 */
export function KiloTabBar({ state, emitter, navigateToTab }: TabBarProps) {
  const insets = useSafeAreaInsets();
  const color = themeFor(useSystemScheme()).color;
  return (
    <View
      style={[styles.bar, { height: size.tabBar + insets.bottom, paddingBottom: insets.bottom, backgroundColor: color.surfaceStrong, borderTopColor: color.hairline }]}
      accessibilityRole="tablist"
    >
      {state.routes.map((route, i) => {
        const tab = TABS[route.name];
        if (!tab) return null;
        const focused = state.index === i;
        const tint = focused ? color.accent : color.muted;
        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            accessibilityLabel={tab.label}
            accessibilityState={{ selected: focused }}
            onPress={() => {
              const e = emitter.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
              if (!focused && !e.defaultPrevented) navigateToTab(route.key);
            }}
            style={styles.item}
          >
            <Icon name={tab.icon} size={20} color={tint} />
            <Text variant="label" weight={500} style={{ color: tint }}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    borderTopWidth: 1,
  },
  item: { minWidth: 72, minHeight: size.touch, alignItems: 'center', justifyContent: 'center', gap: 4 },
});
