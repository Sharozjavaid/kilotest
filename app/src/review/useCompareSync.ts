import { useCallback, useEffect, useRef, useState } from 'react';
import type { SkipPlayer } from './useSkipPlayer';
import { crossedMoment, followAction } from './versions';

/** How often, while playing, the follower is checked against the leader. */
const CHECK_MS = 100;
/** A "cut here" hint stays this long after the moment that raised it. */
export const CUT_HINT_MS = 1200;
/** After asking the follower to play, wait this long for it to start before asking again. */
const PLAY_SETTLE_MS = 400;

export interface CutHints {
  /** The older version lost the footage the newer one is playing. */
  older: boolean;
  /** The newer version cut footage here (playback just ran over a cut). */
  newer: boolean;
}

export interface CompareSync {
  playing: boolean;
  hints: CutHints;
  toggle: () => void;
  pause: () => void;
  /** Seek both to a moment of the newer version (a change in the list). `cut` shows the hint on the newer player. */
  seek: (t: number, opts?: { cut?: boolean }) => void;
  scrub: (t: number) => void;
  scrubEnd: () => void;
}

/**
 * Two skip players in step. The newer version leads: the one play/pause and the scrub bar drive
 * it, on its own output timeline. The older follows through `map` (`mapTime(newer, older, t)`):
 * it plays along and is re-seeked only when it drifts past the limit (`followAction`), and holds
 * still while the leader plays footage it cut. Checks run every 100 ms while playing, from a frame
 * loop; React re-renders only when a hint shows or goes.
 */
export function useCompareSync(lead: SkipPlayer, follow: SkipPlayer, map: (t: number) => { t: number; gone: boolean }, cutMoments: readonly number[]): CompareSync {
  const latest = useRef({ lead, follow, map, cutMoments });
  latest.current = { lead, follow, map, cutMoments };

  const [hints, setHints] = useState<CutHints>({ older: false, newer: false });
  const timers = useRef<Partial<Record<keyof CutHints, ReturnType<typeof setTimeout>>>>({});
  const flash = useCallback((side: keyof CutHints) => {
    setHints((h) => (h[side] ? h : { ...h, [side]: true }));
    clearTimeout(timers.current[side]);
    timers.current[side] = setTimeout(() => setHints((h) => (h[side] ? { ...h, [side]: false } : h)), CUT_HINT_MS);
  }, []);
  useEffect(() => {
    const t = timers.current;
    return () => {
      clearTimeout(t.older);
      clearTimeout(t.newer);
    };
  }, []);

  const playAsked = useRef(0);
  const align = useCallback(
    (leaderPlaying: boolean) => {
      const L = latest.current;
      const target = L.map(L.lead.now().outTime);
      const f = L.follow.now();
      const a = followAction({ leaderPlaying, followerPlaying: L.follow.player.playing, followerT: f.outTime, followerEnded: f.ended, target });
      if (target.gone) flash('older');
      if (a.seekTo !== null) L.follow.seekToOutput(a.seekTo);
      if (a.pause) L.follow.pause();
      if (a.play && Date.now() - playAsked.current > PLAY_SETTLE_MS) {
        playAsked.current = Date.now();
        L.follow.play();
      }
    },
    [flash],
  );

  // While the leader plays: check the follower every CHECK_MS, and notice the leader running over a cut.
  const leadPlaying = lead.playing;
  useEffect(() => {
    if (!leadPlaying) {
      // Paused (or ended): the follower stops on the matching frame.
      align(false);
      return;
    }
    let raf = 0;
    let last = 0;
    let prev = latest.current.lead.now().outTime;
    const loop = (ts: number) => {
      if (ts - last >= CHECK_MS) {
        last = ts;
        const t = latest.current.lead.now().outTime;
        if (crossedMoment(prev, t, latest.current.cutMoments)) flash('newer');
        prev = t;
        align(true);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [leadPlaying, align, flash]);

  const scrubbing = useRef<{ wasPlaying: boolean } | null>(null);

  const play = useCallback(() => {
    const L = latest.current;
    L.lead.play();
    // The leader may restart from 0 (it had ended): put the follower where it now is, then start it.
    playAsked.current = 0;
    align(true);
  }, [align]);

  const pause = useCallback(() => {
    latest.current.lead.pause();
    latest.current.follow.pause();
  }, []);

  return {
    playing: leadPlaying,
    hints,
    toggle: () => (leadPlaying ? pause() : play()),
    pause,
    seek: (t, opts) => {
      latest.current.lead.seekToOutput(t);
      if (opts?.cut) flash('newer');
      playAsked.current = 0;
      align(leadPlaying);
    },
    scrub: (t) => {
      const L = latest.current;
      if (!scrubbing.current) {
        scrubbing.current = { wasPlaying: L.lead.player.playing };
        if (scrubbing.current.wasPlaying) pause();
      }
      L.lead.seekToOutput(t);
      align(false);
    },
    scrubEnd: () => {
      const was = scrubbing.current?.wasPlaying ?? false;
      scrubbing.current = null;
      if (was) play();
    },
  };
}
