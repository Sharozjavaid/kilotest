import { useEffect, useState } from 'react';
import { Platform, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from '@/auth/AuthProvider';
import { createQueryClient } from '@/api/queries';
import { wireOnlineManager } from '@/lib/network';
import { UploadManager } from '@/uploads/UploadManager';
import { PushManager } from '@/push/PushManager';
import { fontFamily } from '@/ui/tokens';
import { useInter } from '@/ui/fonts';
import { DEFAULT_SCREEN_APPEARANCE, ThemeProvider, resolveScheme, themeFor, useSystemScheme } from '@/ui/theme';
import { sheet } from '@/ui/sheets';
import { ToastProvider } from '@/ui/Toast';

void SplashScreen.preventAutoHideAsync().catch(() => undefined);
wireOnlineManager();

export default function RootLayout() {
  const fontsReady = useInter();
  const [queryClient] = useState(createQueryClient);

  if (!fontsReady) return null;
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <ToastProvider>
              <AuthProvider>
                <Navigator />
              </AuthProvider>
            </ToastProvider>
          </ThemeProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function Navigator() {
  const auth = useAuth();
  const signedIn = auth.status === 'signedIn';
  const system = useSystemScheme();
  const t = themeFor(resolveScheme(DEFAULT_SCREEN_APPEARANCE, system));

  useEffect(() => {
    if (auth.status !== 'loading') void SplashScreen.hideAsync().catch(() => undefined);
  }, [auth.status]);

  if (auth.status === 'loading') return null;
  return (
    <>
      <StatusBar style={t.statusBar} />
      {signedIn && auth.session ? (
        <>
          <UploadManager userId={auth.session.userId} />
          <PushManager key={auth.session.userId} />
        </>
      ) : null}
      <Stack
        screenOptions={{
          // Screens draw their own header until they pass `header` to <Screen>, which turns the
          // native bar on for that route (iOS). These are the bar's defaults when it is on.
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
      >
        <Stack.Protected guard={signedIn}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="new-batch" options={sheet.page()} />
          <Stack.Screen name="batch/[id]" />
          <Stack.Screen name="videos" />
          <Stack.Screen name="review/[id]" />
          <Stack.Screen name="export/[id]" />
          <Stack.Screen name="record/index" />
          <Stack.Screen name="record/camera" options={{ contentStyle: { backgroundColor: t.color.cameraScrim }, gestureEnabled: false }} />
          <Stack.Screen name="record/finish" />
          {/* Sheets of the design brief, iOS only (Android and web push them as before). */}
          <Stack.Screen name="broll/[id]" options={sheet.page()} />
          <Stack.Screen name="goal" options={sheet.form(['medium', 'large'])} />
          <Stack.Screen name="style/[id]" options={({ route }) => ((route.params as { id?: string } | undefined)?.id === 'new' ? sheet.page() : {})} />
        </Stack.Protected>
        {/* In mock mode the welcome screen stays reachable for review and screenshots. */}
        <Stack.Protected guard={!signedIn || auth.mode === 'mock'}>
          <Stack.Screen name="welcome" />
        </Stack.Protected>
      </Stack>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
