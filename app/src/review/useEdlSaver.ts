import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Edl, VideoDetail } from '@kilo/edl';
import { getApi } from '@/api/client';
import { keys } from '@/api/queries';
import { KiloApiError } from '@/api/errors';
import { EdlSaver, type SaverState } from './reconcile';

/**
 * Binds an EdlSaver to a video: debounced PUT /edl, 409 reconciliation, and the
 * react-query cache kept in step with what the server stored.
 */
export function useEdlSaver(videoId: string, edl: Edl | null) {
  const qc = useQueryClient();
  const saverRef = useRef<EdlSaver | null>(null);
  const [state, setState] = useState<SaverState | null>(null);

  if (edl && (!saverRef.current || saverRef.current.getState().server.videoId !== edl.videoId)) {
    saverRef.current?.dispose();
    saverRef.current = new EdlSaver(edl, {
      save: async (body, baseRevision) => {
        const res = await getApi().saveEdl(videoId, { edl: body, baseRevision });
        qc.setQueryData<VideoDetail>(keys.video(videoId), (old) => (old ? { ...old, edl: res.edl } : old));
        void qc.invalidateQueries({ queryKey: keys.home });
        return res.edl;
      },
      fetchLatest: async () => {
        const v = await getApi().getVideo(videoId);
        qc.setQueryData(keys.video(videoId), v);
        if (!v.edl) throw new KiloApiError(409, 'invalid_state', 'This video is being edited again. Try in a moment.');
        return v.edl;
      },
      onChange: setState,
    });
  }

  // Newer EDLs from polling (a replan, another device) are adopted under the pending taps.
  useEffect(() => {
    if (edl) saverRef.current?.receive(edl);
  }, [edl]);

  // Save whatever is pending when the screen goes away.
  useEffect(
    () => () => {
      const saver = saverRef.current;
      if (saver) void saver.flush().finally(() => saver.dispose());
    },
    [],
  );

  return {
    saver: saverRef.current,
    state: state ?? saverRef.current?.getState() ?? null,
  };
}
