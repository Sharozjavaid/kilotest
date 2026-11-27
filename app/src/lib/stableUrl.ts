import { useCallback, useRef, useState } from 'react';

/**
 * The link each list item last showed, kept across unmounts. A virtualised list unmounts
 * rows that scroll away and mounts them again with whatever link the latest response
 * signed; without this every scroll back would load the picture again from a new URL.
 */
const remembered = new Map<string, string>();
const REMEMBER_MAX = 2000;

function remember(key: string, url: string): void {
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
export function useStableUrl(latest: string | null, key?: string): { url: string | null; renew: () => boolean } {
  const [url, setUrlState] = useState(() => (key ? remembered.get(key) ?? latest : latest));
  const setUrl = useCallback(
    (next: string | null) => {
      if (key && next) remember(key, next);
      setUrlState(next);
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
