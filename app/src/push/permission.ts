import { Linking, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

/** Notification permission, asked at the moment a reminder is turned on. */
export type NotificationPermission = 'granted' | 'denied' | 'undetermined' | 'unavailable';

type WebNotification = { permission: 'default' | 'denied' | 'granted'; requestPermission: () => Promise<'default' | 'denied' | 'granted'> };

function webApi(): WebNotification | null {
  return (globalThis as { Notification?: WebNotification }).Notification ?? null;
}

function fromWeb(p: 'default' | 'denied' | 'granted'): NotificationPermission {
  return p === 'default' ? 'undetermined' : p;
}

export async function getNotificationPermission(): Promise<NotificationPermission> {
  if (Platform.OS === 'web') {
    const N = webApi();
    return N ? fromWeb(N.permission) : 'unavailable';
  }
  const p = await Notifications.getPermissionsAsync();
  if (p.granted) return 'granted';
  return p.canAskAgain ? 'undetermined' : 'denied';
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (Platform.OS === 'web') {
    const N = webApi();
    if (!N) return 'unavailable';
    return fromWeb(await N.requestPermission());
  }
  const current = await getNotificationPermission();
  if (current !== 'undetermined') return current;
  const p = await Notifications.requestPermissionsAsync();
  return p.granted ? 'granted' : 'denied';
}

/** Opens the app's page in system settings (native). */
export function openNotificationSettings(): void {
  if (Platform.OS !== 'web') void Linking.openSettings();
}
