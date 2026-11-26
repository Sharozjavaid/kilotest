import { Tabs } from 'expo-router';
import { KiloTabBar } from '@/components/KiloTabBar';

/** Videos / Styles / You. Styles and You are placeholders for the next screens. */
export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false }} tabBar={(props) => <KiloTabBar {...props} />}>
      <Tabs.Screen name="index" options={{ title: 'Videos' }} />
      <Tabs.Screen name="styles" options={{ title: 'Styles' }} />
      <Tabs.Screen name="you" options={{ title: 'You' }} />
    </Tabs>
  );
}
