import { useEffect } from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { getApi } from '@/api/client';
import { onBeforeSignOut } from '@/auth/signOutHooks';
import { routeForPush } from './routing';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

/** Asks for permission and returns the Expo push token, or null when push is unavailable. */
export async function getPushToken(): Promise<string | null> {
  if (Platform.OS === 'web' || !Device.isDevice) return null;
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Kilo',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }
  const current = await Notifications.getPermissionsAsync();
  const status = current.granted ? 'granted' : (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return null;
  const projectId =
    (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId) {
    console.warn('Push disabled: no EAS projectId in app config (extra.eas.projectId).');
    return null;
  }
  const token = await Notifications.getExpoPushTokenAsync({ projectId });
  return token.data;
}

/**
 * Mount once while signed in: registers this device with POST /v1/devices and
 * routes notification taps (including the one that launched the app).
 */
export function PushManager() {
  useEffect(() => {
    let cancelled = false;
    let registered: string | null = null;
    // On sign-out, before the session goes: the server keeps a token with the account that
    // registered it until that account lets go, so the next person to sign in here can take it.
    const offSignOut = onBeforeSignOut(async () => {
      if (registered) await getApi().unregisterDevice({ expoPushToken: registered });
    });
    getPushToken()
      .then(async (token) => {
        if (!token || cancelled) return;
        const platform = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';
        await getApi().registerDevice({ expoPushToken: token, platform });
        registered = token;
      })
      .catch((e) => console.warn('Push registration failed', e));

    if (Platform.OS === 'web')
      return () => {
        cancelled = true;
        offSignOut();
      };

    const open = (response: Notifications.NotificationResponse | null) => {
      const route = routeForPush(response?.notification.request.content.data);
      if (route) router.push(route as never);
    };
    const last = Notifications.getLastNotificationResponse();
    if (last) open(last);
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    return () => {
      cancelled = true;
      offSignOut();
      sub.remove();
    };
  }, []);
  return null;
}
