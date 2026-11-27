import { Platform, StyleSheet, View } from 'react-native';
import { Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fontFamily } from '@/ui/tokens';
import { themeFor, useSystemScheme } from '@/ui/theme';
import { hasLiquidGlass } from '@/ui/glass';
import { useToastInset } from '@/ui/Toast';
import { UploadAccessory, useHasActiveUploads } from '@/ui/UploadAccessory';

/**
 * Each tab's own stack (Videos, Styles, You). Native tabs draw no header, so the tab's root
 * screen sits in a stack of its own to get the native navigation bar on iOS: Home's transparent
 * bar with the glass All videos / New capsule, the large titles of Styles and You. Pushed
 * screens (Batch, Review, Export, ...) still open on the root stack, over the tab bar.
 *
 * Where the system has no bottom accessory (iOS before 26, Android, web), the uploads capsule
 * floats here above the tab bar instead (design brief section 7).
 */
export function TabStack() {
  const t = themeFor(useSystemScheme());
  const stack = (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: t.color.ground },
        ...(Platform.OS === 'ios'
          ? {
              headerBackButtonDisplayMode: 'minimal' as const,
              headerShadowVisible: false,
              headerTintColor: t.color.ink,
              headerTitleStyle: { fontFamily: fontFamily[600], fontSize: 17, color: t.color.ink },
              headerLargeTitleStyle: { fontFamily: fontFamily[600], fontSize: 34, color: t.color.ink },
            }
          : null),
      }}
    />
  );
  // iOS 26: the stack is the tab's only child, so the tab bar can follow its scroll view
  // (minimise on scroll); the uploads progress is the native bottom accessory.
  if (Platform.OS === 'ios' && hasLiquidGlass()) {
    return (
      <>
        {stack}
        <TabToastInset />
      </>
    );
  }
  return (
    <View style={styles.root}>
      {stack}
      <FloatingUploads />
    </View>
  );
}

/** Height of the tab bar from the bottom edge of the screen, home indicator included. */
function tabBarHeight(bottomInset: number): number {
  if (Platform.OS === 'web') return 72 + bottomInset; // KiloTabBar
  if (Platform.OS === 'android') return 80 + bottomInset; // Material bottom navigation
  return 49 + bottomInset; // UITabBar
}

/** Toasts on a tab sit above the tab bar (and the uploads capsule when it shows). */
function TabToastInset() {
  const insets = useSafeAreaInsets();
  const uploading = useHasActiveUploads();
  const accessory = uploading ? (Platform.OS === 'ios' && hasLiquidGlass() ? 48 : 56) : 0;
  useToastInset(tabBarHeight(insets.bottom) + accessory);
  return null;
}

/** The 44pt uploads capsule, 12 above the tab bar, while this phone is sending files. */
function FloatingUploads() {
  const insets = useSafeAreaInsets();
  const uploading = useHasActiveUploads();
  // On Android and web the tab's content already ends at the tab bar; on iOS it runs under it.
  const bottom = (Platform.OS === 'ios' ? tabBarHeight(insets.bottom) : 0) + 12;
  return (
    <>
      <TabToastInset />
      {uploading ? (
        <View pointerEvents="box-none" style={[styles.capsule, { bottom }]}>
          <UploadAccessory placement="capsule" />
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  capsule: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
});
