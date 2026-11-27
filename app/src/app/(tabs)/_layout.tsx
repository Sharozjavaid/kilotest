import { Tabs } from 'expo-router';
import { KiloTabBar } from '@/components/KiloTabBar';

/**
 * Videos / Styles / You on web: Kilo's own tab bar, which the browser end-to-end suite drives
 * (role `tab`, names Videos, Styles, You). iOS and Android use the native tab bar
 * (`_layout.native.tsx`).
 */
export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false }} tabBar={(props) => <KiloTabBar {...props} />}>
      <Tabs.Screen name="index" options={{ title: 'Videos' }} />
      <Tabs.Screen name="styles" options={{ title: 'Styles' }} />
      <Tabs.Screen name="you" options={{ title: 'You' }} />
    </Tabs>
  );
}
