/**
 * Work that must happen before a session is cleared: unregister this device's push
 * token (the server only lets go of it for the account that registered it) and drop
 * the signed-out account's upload queue. Each hook gets a few seconds; a hook that
 * fails or hangs never keeps the user signed in.
 */
type Hook = () => Promise<void> | void;

const hooks = new Set<Hook>();

export function onBeforeSignOut(fn: Hook): () => void {
  hooks.add(fn);
  return () => hooks.delete(fn);
}

export async function runBeforeSignOut(timeoutMs = 4000): Promise<void> {
  await Promise.all(
    [...hooks].map((fn) =>
      Promise.race([
        Promise.resolve()
          .then(fn)
          .catch(() => undefined),
        new Promise<void>((r) => setTimeout(r, timeoutMs)),
      ]),
    ),
  );
}
