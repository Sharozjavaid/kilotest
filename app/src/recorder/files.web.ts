/** Takes on web are blob: URLs that live as long as the page. */
const live = new Set<string>();

export function registerBlobUrl(uri: string): void {
  live.add(uri);
}

export function takeFileExists(uri: string): boolean {
  return live.has(uri);
}

export function deleteTakeFile(uri: string): void {
  if (live.delete(uri)) URL.revokeObjectURL(uri);
}
