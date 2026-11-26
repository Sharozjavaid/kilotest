import { useNetworkState, addNetworkStateListener, getNetworkStateAsync } from 'expo-network';
import { onlineManager } from '@tanstack/react-query';

/** True unless the device reports no connection. Unknown counts as online. */
export function useOnline(): boolean {
  const state = useNetworkState();
  if (state.isConnected === false) return false;
  if (state.isInternetReachable === false) return false;
  return true;
}

/** Lets react-query pause queries and retry mutations when the device goes offline. */
export function wireOnlineManager(): void {
  onlineManager.setEventListener((setOnline) => {
    getNetworkStateAsync()
      .then((s) => setOnline(s.isConnected !== false))
      .catch(() => undefined);
    const sub = addNetworkStateListener((s) => setOnline(s.isConnected !== false));
    return () => sub.remove();
  });
}
