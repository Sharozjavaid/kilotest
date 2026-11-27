import { useCallback, useRef, useState } from 'react';

/**
 * The link each list item last showed, kept across unmounts. A virtualised list unmounts
 * rows that scroll away and mounts them again with whatever link the latest response
 * signed; without this every scroll back would load the picture again from a new URL.
 */
const remembered = new Map<string, string>();
const REMEMBER_MAX = 2000;

/** Remembers the link shown for `key` (exported for tests). */
export function remember(key: string, url: string): void {
  remembered.delete(key);
  remembered.set(key, url);
  if (remembered.size > REMEMBER_MAX) remembered.delete(remembered.keys().next().value!);
}

/** Forgets every remembered link (tests, sign-out). */
export function forgetStableUrls(): void {
  remembered.clear();
}

/**
 * Signed media URLs change on every refetch (each response signs them afresh), but a
 * player reloads whenever its source changes, losing its position mid-playback. This
 * keeps the first URL until `renew()` is called (the player reported an error, which is
 * what an expired link looks like), then switches to the newest one.
 *
 * With a `key` (a video id) the URL in use is also remembered across unmounts, so a row
 * that scrolls out of a virtualised list and back shows the same picture without loading it again.
 */
export interface StableState {
  key: string | undefined;
  url: string | null;
}

/**
 * The link a component should show for `key`, given what it showed before. A recycled list cell
 * (FlashList) keeps its state when it is handed another item: for a new key this starts over
 * (that key's remembered link, else the latest) rather than show, and remember, the previous
 * item's link. Returns `state` itself when nothing changes. Pure apart from reading the memory.
 */
export function stableStateFor(state: StableState | null, key: string | undefined, latest: string | null): StableState {
  if (state && state.key === key) return state;
  return { key, url: key ? remembered.get(key) ?? latest : latest };
}

export function useStableUrl(latest: string | null, key?: string): { url: string | null; renew: () => boolean } {
  const [state, setState] = useState(() => stableStateFor(null, key, latest));
  const current = stableStateFor(state, key, latest);
  if (current !== state) setState(current);
  const url = current.url;
  const setUrl = useCallback(
    (next: string | null) => {
      if (key && next) remember(key, next);
      setState({ key, url: next });
    },
    [key],
  );
  const latestRef = useRef(latest);
  latestRef.current = latest;
  if (url === null && latest !== null) setUrl(latest);
  else if (key && url && remembered.get(key) !== url) remember(key, url);
  const renew = useCallback(() => {
    const next = latestRef.current;
    if (!next || next === url) return false;
    setUrl(next);
    return true;
  }, [url, setUrl]);
  return { url, renew };
}
