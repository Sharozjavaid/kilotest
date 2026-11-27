import { useCallback, useRef, useState } from 'react';

/**
 * Signed media URLs change on every refetch (each response signs them afresh), but a
 * player reloads whenever its source changes, losing its position mid-playback. This
 * keeps the first URL until `renew()` is called (the player reported an error, which is
 * what an expired link looks like), then switches to the newest one.
 */
export function useStableUrl(latest: string | null): { url: string | null; renew: () => boolean } {
  const [url, setUrl] = useState(latest);
  const latestRef = useRef(latest);
  latestRef.current = latest;
  if (url === null && latest !== null) setUrl(latest);
  const renew = useCallback(() => {
    const next = latestRef.current;
    if (!next || next === url) return false;
    setUrl(next);
    return true;
  }, [url]);
  return { url, renew };
}
