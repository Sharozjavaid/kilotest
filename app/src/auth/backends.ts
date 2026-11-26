import 'react-native-url-polyfill/auto';
import { AppState, Platform } from 'react-native';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { authMode, env, type AuthMode } from '@/lib/env';
import { secureStorage } from './secureStorage';

/**
 * Sign-in backends behind one interface:
 * - `supabase`: email one-time code (EXPO_PUBLIC_SUPABASE_URL set).
 * - `dev`: the server's dev auth, token `dev:<generated id>` (no Supabase, no mock).
 * - `mock`: signed in automatically; any 6-digit code works on the welcome screen.
 */

export interface Session {
  userId: string;
  email: string | null;
  /** Bearer token for the Kilo API. */
  accessToken: string;
}

export interface AuthBackend {
  mode: AuthMode;
  /** True when the user must sign in (the welcome screen applies). */
  needsSignIn: boolean;
  getSession(): Promise<Session | null>;
  /** Current token, refreshed if needed. */
  getToken(): Promise<string | null>;
  sendCode(email: string): Promise<void>;
  verifyCode(email: string, code: string): Promise<Session>;
  signOut(): Promise<void>;
  onChange(fn: (s: Session | null) => void): () => void;
}

let supabase: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!supabase) {
    supabase = createClient(env.supabaseUrl, env.supabaseAnonKey, {
      auth: {
        storage: secureStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
    });
    if (Platform.OS !== 'web') {
      // Refresh only while in the foreground, as Supabase recommends for React Native.
      AppState.addEventListener('change', (s) => {
        if (s === 'active') void supabase!.auth.startAutoRefresh();
        else void supabase!.auth.stopAutoRefresh();
      });
    }
  }
  return supabase;
}

function supabaseBackend(): AuthBackend {
  const sb = getSupabase();
  const toSession = (s: { access_token: string; user: { id: string; email?: string | null } } | null): Session | null =>
    s ? { userId: s.user.id, email: s.user.email ?? null, accessToken: s.access_token } : null;
  return {
    mode: 'supabase',
    needsSignIn: true,
    async getSession() {
      const { data } = await sb.auth.getSession();
      return toSession(data.session);
    },
    async getToken() {
      const { data } = await sb.auth.getSession();
      return data.session?.access_token ?? null;
    },
    async sendCode(email) {
      const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
      if (error) throw new Error(error.message);
    },
    async verifyCode(email, code) {
      const { data, error } = await sb.auth.verifyOtp({ email, token: code, type: 'email' });
      if (error) throw new Error(error.message);
      const s = toSession(data.session);
      if (!s) throw new Error('That code did not sign you in. Ask for a new one.');
      return s;
    },
    async signOut() {
      await sb.auth.signOut();
    },
    onChange(fn) {
      const { data } = sb.auth.onAuthStateChange((_e, s) => fn(toSession(s)));
      return () => data.subscription.unsubscribe();
    },
  };
}

const DEV_KEY = 'kilo.devUserId';

function randomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function devBackend(): AuthBackend {
  const listeners = new Set<(s: Session | null) => void>();
  const session = async (): Promise<Session> => {
    let id = await secureStorage.getItem(DEV_KEY);
    if (!id) {
      id = randomId();
      await secureStorage.setItem(DEV_KEY, id);
    }
    return { userId: id, email: null, accessToken: `dev:${id}` };
  };
  return {
    mode: 'dev',
    needsSignIn: false,
    getSession: session,
    getToken: async () => (await session()).accessToken,
    sendCode: async () => undefined,
    verifyCode: session,
    async signOut() {
      // A new id is a new (empty) dev account.
      await secureStorage.removeItem(DEV_KEY);
      const s = await session();
      listeners.forEach((l) => l(s));
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

function mockBackend(): AuthBackend {
  const s: Session = { userId: 'mock-user', email: 'creator@example.com', accessToken: 'mock' };
  const listeners = new Set<(s: Session | null) => void>();
  return {
    mode: 'mock',
    needsSignIn: false,
    getSession: async () => s,
    getToken: async () => s.accessToken,
    sendCode: async () => undefined,
    async verifyCode(_email, code) {
      if (!/^\d{6}$/.test(code)) throw new Error('Enter the 6-digit code.');
      return s;
    },
    signOut: async () => listeners.forEach((l) => l(s)),
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

let backend: AuthBackend | null = null;

export function getAuthBackend(): AuthBackend {
  if (!backend) {
    const mode = authMode();
    backend = mode === 'mock' ? mockBackend() : mode === 'supabase' ? supabaseBackend() : devBackend();
  }
  return backend;
}
