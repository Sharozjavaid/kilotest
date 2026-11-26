import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { setTokenProvider, setUnauthorizedHandler } from '@/api/client';
import type { AuthMode } from '@/lib/env';
import { getAuthBackend, type Session } from './backends';

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
    setUnauthorizedHandler(() => {
      if (backend.needsSignIn) void backend.signOut();
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
      signOut: () => backend.signOut(),
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
