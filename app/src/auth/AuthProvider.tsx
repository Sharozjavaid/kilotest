import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { setTokenProvider, setUnauthorizedHandler } from '@/api/client';
import type { AuthMode } from '@/lib/env';
import { getAuthBackend, type Session } from './backends';
import { runBeforeSignOut } from './signOutHooks';

export interface AuthState {
  status: 'loading' | 'signedOut' | 'signedIn';
  session: Session | null;
  mode: AuthMode;
  sendCode: (email: string) => Promise<void>;
  verifyCode: (email: string, code: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const backend = getAuthBackend();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setTokenProvider(() => backend.getToken());
    // Only a 401 (the server rejected the token) lands here; a 503 "could not verify" is retried instead.
    setUnauthorizedHandler(() => {
      if (backend.needsSignIn) void runBeforeSignOut(1500).finally(() => backend.signOut());
    });
    let alive = true;
    backend
      .getSession()
      .then((s) => alive && setSession(s))
      .catch(() => alive && setSession(null))
      .finally(() => alive && setLoading(false));
    const off = backend.onChange((s) => setSession(s));
    return () => {
      alive = false;
      off();
    };
  }, [backend]);

  const value = useMemo<AuthState>(
    () => ({
      status: loading ? 'loading' : session ? 'signedIn' : 'signedOut',
      session,
      mode: backend.mode,
      sendCode: (email) => backend.sendCode(email),
      verifyCode: async (email, code) => {
        setSession(await backend.verifyCode(email, code));
      },
      // Unregister push and drop this account's uploads while the session (and its token) still works.
      signOut: async () => {
        await runBeforeSignOut();
        await backend.signOut();
      },
    }),
    [loading, session, backend],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
