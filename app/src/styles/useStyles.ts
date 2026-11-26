import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SaveStyleRequest, Style } from '@kilo/edl';
import { getApi } from '@/api/client';
import { keys } from '@/api/queries';

export function useStyles() {
  return useQuery({ queryKey: keys.styles, queryFn: async () => (await getApi().listStyles()).styles });
}

/** Create (no id) or update a style; refreshes the list (a new default clears the old one). */
export function useSaveStyle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id?: string; body: SaveStyleRequest }): Promise<Style> => (id ? getApi().updateStyle(id, body) : getApi().createStyle(body)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.styles }),
  });
}

export function useDeleteStyle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApi().deleteStyle(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.styles }),
  });
}
