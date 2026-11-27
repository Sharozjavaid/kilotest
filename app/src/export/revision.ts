/**
 * Whether the server's edit is the one the creator reviewed. `ahead`: it changed
 * since (a replan, another device), so exporting would render something they have not
 * seen. `behind`: this screen's copy is older than the save Review just made; refetch.
 */
export function revisionCheck(serverRevision: number, reviewed: number | null): 'ok' | 'ahead' | 'behind' {
  if (reviewed === null || serverRevision === reviewed) return 'ok';
  return serverRevision > reviewed ? 'ahead' : 'behind';
}

/** Where Export's "Next video" goes for the batch's next video: its export, its review, or the batch while it is not ready. */
export function nextVideoHref(next: { id: string; batchId: string; status: string }): string {
  if (next.status === 'done') return `/export/${next.id}`;
  if (next.status === 'ready_for_review' || next.status === 'rendering') return `/review/${next.id}`;
  return `/batch/${next.batchId}`;
}
