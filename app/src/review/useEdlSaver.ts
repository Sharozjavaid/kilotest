import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Edl, VideoDetail } from '@kilo/edl';
import { getApi } from '@/api/client';
import { keys } from '@/api/queries';
import { KiloApiError } from '@/api/errors';
import { EdlSaver, type SaverState } from './reconcile';
import { pendingStore } from './pendingStore';

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
        // Saving can move a finished video back to review on the server; refetch its status.
        void qc.invalidateQueries({ queryKey: keys.video(videoId) });
        void qc.invalidateQueries({ queryKey: keys.home });
        // Every save is a new version.
        void qc.invalidateQueries({ queryKey: keys.edlVersions(videoId) });
        return res.edl;
      },
      fetchLatest: async () => {
        const v = await getApi().getVideo(videoId);
        qc.setQueryData(keys.video(videoId), v);
        if (!v.edl) throw new KiloApiError(409, 'invalid_state', 'This video is being edited again. Try in a moment.');
        return v.edl;
      },
      onChange: setState,
      // Every unsaved tap is on the device too: a failed save survives this screen going away.
      persist: (snap) => pendingStore.save(videoId, snap),
    });
    // Taps an earlier visit could not save are replayed on top of the server's edit.
    const created = saverRef.current;
    void pendingStore.load(videoId).then((snap) => {
      if (snap && saverRef.current === created) created.restore(snap);
    });
  }

  // Newer EDLs from polling (a replan, another device) are adopted under the pending taps.
  useEffect(() => {
    if (edl) saverRef.current?.receive(edl);
  }, [edl]);

  // Save whatever is pending when the screen goes away. If that fails the operations stay on the
  // device (persist above) and are replayed the next time this video is opened.
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
