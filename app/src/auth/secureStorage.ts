import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/**
 * Key-value storage for secrets (the Supabase session, the dev user id).
 * iOS Keychain / Android Keystore via expo-secure-store; values are split into
 * chunks because SecureStore warns above 2 KB and sessions can be larger.
 * On web (mock and local development only) it falls back to localStorage.
 */

const CHUNK = 1800;

function webStore(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

const safeKey = (key: string) => key.replace(/[^A-Za-z0-9._-]/g, '_');

export const secureStorage = {
  async getItem(key: string): Promise<string | null> {
    if (Platform.OS === 'web') return webStore()?.getItem(key) ?? null;
    const k = safeKey(key);
    const count = await SecureStore.getItemAsync(`${k}.n`);
    if (count === null) return null;
    const parts: string[] = [];
    for (let i = 0; i < Number(count); i++) {
      const part = await SecureStore.getItemAsync(`${k}.${i}`);
      if (part === null) return null;
      parts.push(part);
    }
    return parts.join('');
  },
  async setItem(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') {
      webStore()?.setItem(key, value);
      return;
    }
    const k = safeKey(key);
    await secureStorage.removeItem(key);
    const n = Math.max(1, Math.ceil(value.length / CHUNK));
    for (let i = 0; i < n; i++) await SecureStore.setItemAsync(`${k}.${i}`, value.slice(i * CHUNK, (i + 1) * CHUNK));
    await SecureStore.setItemAsync(`${k}.n`, String(n));
  },
  async removeItem(key: string): Promise<void> {
    if (Platform.OS === 'web') {
      webStore()?.removeItem(key);
      return;
    }
    const k = safeKey(key);
    const count = await SecureStore.getItemAsync(`${k}.n`);
    if (count === null) return;
    for (let i = 0; i < Number(count); i++) await SecureStore.deleteItemAsync(`${k}.${i}`);
    await SecureStore.deleteItemAsync(`${k}.n`);
  },
};
