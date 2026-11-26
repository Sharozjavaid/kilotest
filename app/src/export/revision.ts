/**
 * Whether the server's edit is the one the creator reviewed. `ahead`: it changed
 * since (a replan, another device), so exporting would render something they have not
 * seen. `behind`: this screen's copy is older than the save Review just made; refetch.
 */
export function revisionCheck(serverRevision: number, reviewed: number | null): 'ok' | 'ahead' | 'behind' {
  if (reviewed === null || serverRevision === reviewed) return 'ok';
  return serverRevision > reviewed ? 'ahead' : 'behind';
}
