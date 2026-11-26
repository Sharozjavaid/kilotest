import { useCallback, useEffect, useRef, useState } from 'react';
import { useEvent } from 'expo';
import { useVideoPlayer, type VideoPlayer } from 'expo-video';
import type { PlaybackRange } from '@kilo/edl';
import { PlaybackController, type PlaybackSnapshot } from './playback';

/** How often the UI (playhead, active row, time) re-renders while playing. */
const UI_INTERVAL_MS = 80;

export interface SkipPlayer {
  player: VideoPlayer;
  playing: boolean;
  snapshot: PlaybackSnapshot;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  /** Seek to a segment (kept: plays from it; cut: auditions it). */
  seekToSegment: (segmentId: string, span: { proxyStart: number; proxyEnd: number }, offsetSec?: number) => void;
  seekToOutput: (outTime: number) => void;
}

/**
 * Plays the concatenated review proxy and skips the cut ranges. The decisions are
 * made by PlaybackController (pure, unit-tested); this hook only connects it to an
 * expo-video player with a frame loop while playing.
 */
export function useSkipPlayer(url: string | null, ranges: PlaybackRange[]): SkipPlayer {
  const player = useVideoPlayer(url ? { uri: url } : null, (p) => {
    p.loop = false;
    p.timeUpdateEventInterval = 0;
  });
  const controllerRef = useRef<PlaybackController | null>(null);
  if (!controllerRef.current) controllerRef.current = new PlaybackController(ranges);
  const controller = controllerRef.current;
  const [snapshot, setSnapshot] = useState<PlaybackSnapshot>(() => controller.snapshot());
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });

  useEffect(() => {
    controller.setRanges(ranges);
    setSnapshot(controller.snapshot());
  }, [controller, ranges]);

  // Start the paused player on the first kept frame, not on the cut opening.
  const { status } = useEvent(player, 'statusChange', { status: player.status });
  const primed = useRef(false);
  useEffect(() => {
    if (status === 'readyToPlay' && !primed.current) {
      primed.current = true;
      const first = controller.getRanges()[0];
      if (first && player.currentTime < first.proxyStart) {
        player.currentTime = controller.seekToOutput(0);
        setSnapshot(controller.snapshot());
      }
    }
  }, [status, controller, player]);

  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    let lastUi = 0;
    const loop = (ts: number) => {
      const cmd = controller.tick(player.currentTime);
      if (cmd.type === 'seek') {
        player.currentTime = cmd.to;
      } else if (cmd.type === 'end') {
        player.pause();
        player.currentTime = cmd.seekTo;
      }
      if (ts - lastUi > UI_INTERVAL_MS || cmd.type !== 'none') {
        lastUi = ts;
        setSnapshot(controller.snapshot());
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, controller, player]);

  const play = useCallback(() => {
    const t = controller.startPosition();
    if (Math.abs(player.currentTime - t) > 0.05) player.currentTime = t;
    player.play();
    setSnapshot(controller.snapshot());
  }, [controller, player]);

  const pause = useCallback(() => {
    player.pause();
    setSnapshot(controller.snapshot());
  }, [controller, player]);

  return {
    player,
    playing: isPlaying,
    snapshot,
    play,
    pause,
    toggle: () => (isPlaying ? pause() : play()),
    seekToSegment: (segmentId, span, offsetSec) => {
      player.currentTime = controller.seekToSegment(segmentId, span, offsetSec);
      setSnapshot(controller.snapshot());
    },
    seekToOutput: (outTime) => {
      player.currentTime = controller.seekToOutput(outTime);
      setSnapshot(controller.snapshot());
    },
  };
}
