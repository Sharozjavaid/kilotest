import type { PickedFile } from './grouping';

/**
 * Clips picked before the New batch sheet opens (design brief 3: "Upload clips opens the system
 * photo picker straight away; only after the picker returns does the New batch sheet open,
 * already holding the clips"). Home puts the picks here and opens the sheet; the sheet takes
 * them once, when it mounts. Plain module state: a route param would put file URIs in the URL.
 */
let pending: PickedFile[] = [];

export function setPendingPicks(files: readonly PickedFile[]): void {
  pending = [...files];
}

/** The picks waiting for the sheet, once: a second call returns none. */
export function takePendingPicks(): PickedFile[] {
  const out = pending;
  pending = [];
  return out;
}
