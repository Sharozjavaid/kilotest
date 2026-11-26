import { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from '@/auth/AuthProvider';
import { createQueryClient } from '@/api/queries';
import { wireOnlineManager } from '@/lib/network';
import { UploadManager } from '@/uploads/UploadManager';
import { PushManager } from '@/push/PushManager';
import { color } from '@/ui/tokens';
import { useInter } from '@/ui/fonts';

void SplashScreen.preventAutoHideAsync().catch(() => undefined);
wireOnlineManager();

export default function RootLayout() {
  const fontsReady = useInter();
  const [queryClient] = useState(createQueryClient);

  if (!fontsReady) return null;
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <StatusBar style="dark" />
          <Navigator />
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

function Navigator() {
  const auth = useAuth();
  const signedIn = auth.status === 'signedIn';

  useEffect(() => {
    if (auth.status !== 'loading') void SplashScreen.hideAsync().catch(() => undefined);
  }, [auth.status]);

  if (auth.status === 'loading') return null;
  return (
    <>
      {signedIn && auth.session ? (
        <>
          <UploadManager userId={auth.session.userId} />
          <PushManager key={auth.session.userId} />
        </>
      ) : null}
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.ground } }}>
        <Stack.Protected guard={signedIn}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="new-batch" />
          <Stack.Screen name="batch/[id]" />
          <Stack.Screen name="review/[id]" />
          <Stack.Screen name="export/[id]" />
          <Stack.Screen name="record/index" />
          <Stack.Screen name="record/camera" options={{ contentStyle: { backgroundColor: color.cameraScrim }, gestureEnabled: false }} />
          <Stack.Screen name="record/finish" />
          <Stack.Screen name="broll/[id]" />
          <Stack.Screen name="goal" />
          <Stack.Screen name="style/[id]" />
        </Stack.Protected>
        {/* In mock mode the welcome screen stays reachable for review and screenshots. */}
        <Stack.Protected guard={!signedIn || auth.mode === 'mock'}>
          <Stack.Screen name="welcome" />
        </Stack.Protected>
      </Stack>
    </>
  );
}
