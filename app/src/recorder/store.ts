import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { deleteTakeFile, takeFileExists } from './files';
import { newSession, restoreDraft, serializeDraft, type Change, type RecorderMode, type RecorderSession, liveTakes } from './session';

/**
 * The one recording session, shared by the script, camera and finish screens, and
 * saved as a draft on every change so a session survives the app closing. Take files
 * a change no longer needs are deleted here.
 */

const KEY = 'kilo.recorder.draft.v1';

interface State {
  loaded: boolean;
  session: RecorderSession | null;
  /** Takes dropped on restore because their files were gone. */
  lost: number;
}

let state: State = { loaded: false, session: null, lost: 0 };
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;

function emit() {
  for (const l of listeners) l();
}

function persist(s: RecorderSession | null) {
  const p = s ? AsyncStorage.setItem(KEY, serializeDraft(s)) : AsyncStorage.removeItem(KEY);
  void p.catch(() => undefined);
}

/** Loads the saved draft once. */
export function loadRecorder(): Promise<void> {
  if (state.loaded) return Promise.resolve();
  loading ??= AsyncStorage.getItem(KEY)
    .catch(() => null)
    .then((raw) => {
      const r = restoreDraft(raw, takeFileExists);
      state = { loaded: true, session: r?.session ?? null, lost: r?.lost ?? 0 };
      emit();
    });
  return loading;
}

export function getRecorderSession(): RecorderSession | null {
  return state.session;
}

/** Applies a change to the session: saves the draft, deletes takes that are no longer used. */
export function updateRecorder(fn: (s: RecorderSession) => Change | RecorderSession): RecorderSession | null {
  const s = state.session;
  if (!s) return null;
  const out = fn(s);
  const change: Change = 'session' in out ? out : { session: out, discarded: [] };
  const live = new Set(liveTakes(change.session).map((t) => t.uri));
  for (const t of change.discarded) if (!live.has(t.uri)) deleteTakeFile(t.uri);
  state = { ...state, session: change.session };
  persist(change.session);
  emit();
  return change.session;
}

/** Starts a new session, throwing away any previous draft and its takes. */
export function startSession(mode: RecorderMode, text?: string): RecorderSession {
  if (state.session) for (const t of liveTakes(state.session)) deleteTakeFile(t.uri);
  const session = newSession(mode, { text });
  state = { loaded: true, session, lost: 0 };
  persist(session);
  emit();
  return session;
}

/**
 * Ends the session. After a successful finish the takes are left on disk: the upload
 * queue still reads them. Discarding deletes them.
 */
export function endSession({ deleteTakes }: { deleteTakes: boolean }): void {
  if (deleteTakes && state.session) for (const t of liveTakes(state.session)) deleteTakeFile(t.uri);
  state = { loaded: true, session: null, lost: 0 };
  persist(null);
  emit();
}

export function useRecorder(): State {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
    () => state,
  );
}
