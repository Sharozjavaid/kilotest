import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type ScrollViewInstance } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { VideoView } from 'expo-video';
import { edlStats, getTemplate, playbackRanges, type Edl, type Overlay, type VideoDetail } from '@kilo/edl';
import { useBatch, useRender, useRetryVideo, useVideo } from '@/api/queries';
import { getApi } from '@/api/client';
import { errorMessage } from '@/api/errors';
import { formatDuration, plural, statusLabel } from '@/lib/format';
import { useEdlSaver } from '@/review/useEdlSaver';
import { useSkipPlayer } from '@/review/useSkipPlayer';
import { useStableUrl } from '@/lib/stableUrl';
import { ScrubStrip } from '@/review/ScrubStrip';
import { TranscriptRowView, type RowOverlayInfo } from '@/review/TranscriptRowView';
import { CutStepper } from '@/review/CutStepper';
import { cutContextSpan, cutLines, cutReasonText, cutSummary, proxyDuration, stepCut } from '@/review/cuts';
import { markedSegments, rowOverlays } from '@/review/variantOverlays';
import { activeRowId, transcriptRows, type TranscriptRow } from '@/review/rows';
import type { ScrubTarget } from '@/review/scrub';
import { VideoModal } from '@/components/VideoModal';
import { CaptionsControl } from '@/review/CaptionsControl';
import {
  Card,
  ErrorState,
  Header,
  Icon,
  LoadingBlock,
  PillButton,
  ProgressBar,
  Screen,
  SegmentedControl,
  Text,
  color,
  shadow,
} from '@/ui';

/** Review (mock-up `Review`): skip-cut player, scrub strip, tappable transcript. */
export default function ReviewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const video = useVideo(id);
  // Only for "3 of 30": the batch is not polled from here.
  const batch = useBatch(video.data?.batchId, { poll: false });
  const position = useMemo(() => {
    const list = batch.data?.videos ?? [];
    const i = list.findIndex((v) => v.id === id);
    return i >= 0 ? `${i + 1} of ${list.length}` : undefined;
  }, [batch.data, id]);

  const v = video.data;
  const title = v?.title ?? 'Review';

  if (video.isPending) {
    return (
      <Screen>
        <Header title={title} />
        <LoadingBlock />
      </Screen>
    );
  }
  if (!v) {
    return (
      <Screen>
        <Header title={title} />
        <ErrorState error={video.error} onRetry={() => void video.refetch()} />
      </Screen>
    );
  }
  if (!v.edl || !v.proxy) {
    return <NotReady video={v} position={position} />;
  }
  return <ReviewBody video={v as VideoDetail & { edl: Edl; proxy: NonNullable<VideoDetail['proxy']> }} position={position} />;
}

function NotReady({ video, position }: { video: VideoDetail; position?: string }) {
  const retry = useRetryVideo();
  const failed = video.status === 'failed';
  return (
    <Screen>
      <Header title={video.title} meta={position} />
      <Card gap={12} padding={24} style={{ alignItems: 'center' }}>
        <Icon name={failed ? 'alert' : 'sparkle'} size={28} color={failed ? color.cut : color.accent} />
        <Text variant="bodyLg" center>
          {failed ? "Kilo couldn't edit this video" : `${statusLabel(video.status)}…`}
        </Text>
        <Text variant="secondary" tone="muted" center>
          {failed ? video.error ?? 'Something went wrong while editing.' : 'This page updates by itself when the edit is ready.'}
        </Text>
        {failed ? (
          <PillButton variant="secondary" height={44} icon="refresh" label="Try again" loading={retry.isPending} onPress={() => retry.mutate(video.id)} />
        ) : (
          <View style={{ alignSelf: 'stretch' }}>
            <ProgressBar value={video.progress ?? 0} accessibilityLabel={statusLabel(video.status)} />
          </View>
        )}
        {retry.isError ? (
          <Text variant="label" tone="cut">
            {errorMessage(retry.error)}
          </Text>
        ) : null}
      </Card>
    </Screen>
  );
}

function ReviewBody({ video, position }: { video: VideoDetail & { edl: Edl; proxy: NonNullable<VideoDetail['proxy']> }; position?: string }) {
  const { saver, state } = useEdlSaver(video.id, video.edl);
  const edl = state?.local ?? video.edl;
  const offsets = video.proxy.clipOffsets;

  const [variantId, setVariantId] = useState<string | null>(edl.variants[0]?.id ?? null);
  const activeVariant = variantId && edl.variants.some((x) => x.id === variantId) ? variantId : edl.variants[0]?.id ?? null;

  const ranges = useMemo(() => playbackRanges(edl, offsets, activeVariant), [edl, offsets, activeVariant]);
  const stats = useMemo(() => edlStats(edl, activeVariant), [edl, activeVariant]);
  const rows = useMemo(() => transcriptRows(edl, offsets), [edl, offsets]);
  // Lines with B-roll or a graphic in the cut being watched get a marker: what that version shows,
  // so a base overlay a variant leaves out is not marked there.
  const marked = useMemo(() => markedSegments(edl, activeVariant), [edl, activeVariant]);
  // With a variant selected, each line's base overlays split into shown and left out, with a way to change it.
  const variantLabel = edl.variants.find((x) => x.id === activeVariant)?.label ?? null;
  const overlayInfo = useMemo(() => {
    const out = new Map<string, RowOverlayInfo>();
    if (!activeVariant || !variantLabel) return out;
    const item = (o: Overlay) => ({ id: o.id, label: o.type === 'broll' ? 'B-roll' : getTemplate(o.template).name });
    for (const [segmentId, r] of rowOverlays(edl, activeVariant)) out.set(segmentId, { variantLabel, shown: r.shown.map(item), hidden: r.hidden.map(item) });
    return out;
  }, [edl, activeVariant, variantLabel]);
  // The cut lines, why each was cut, and stepping through them.
  const hasScript = !!video.script?.length;
  const cuts = useMemo(() => cutLines(edl, hasScript), [edl, hasScript]);
  const why = useMemo(() => new Map(rows.filter((r) => !r.keep).map((r) => [r.segmentId, cutReasonText(edl, r.segmentId, hasScript)])), [rows, edl, hasScript]);
  const keepBothIds = useMemo(() => new Set(cuts.filter((c) => c.canKeepBoth).map((c) => c.segmentId)), [cuts]);
  const proxySec = useMemo(() => proxyDuration(edl, offsets), [edl, offsets]);
  // The proxy link is re-signed on every refetch; keep one until it stops working.
  const proxyUrl = useStableUrl(video.proxy.url);
  const refetchVideo = useVideo(video.id).refetch;
  const sp = useSkipPlayer(proxyUrl.url, ranges, {
    onError: () => {
      if (!proxyUrl.renew()) void refetchVideo().then(() => proxyUrl.renew());
    },
  });
  const activeId = activeRowId(edl, rows, sp.snapshot.segmentId);

  // A different opening is a different video: start it from its own beginning.
  const shownVariant = useRef(activeVariant);
  useEffect(() => {
    if (shownVariant.current === activeVariant) return;
    shownVariant.current = activeVariant;
    sp.seekToOutput(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeVariant]);

  // ---- transcript auto-scroll ----
  const scrollRef = useRef<ScrollViewInstance>(null);
  const rowY = useRef(new Map<string, number>());
  const userScrolling = useRef(false);
  useEffect(() => {
    if (!sp.playing || !activeId || userScrolling.current) return;
    const y = rowY.current.get(activeId);
    if (y !== undefined) scrollRef.current?.scrollTo({ y: Math.max(0, y - 54), animated: true });
  }, [activeId, sp.playing]);

  const onToggle = useCallback((segmentId: string) => saver?.toggle(segmentId), [saver]);
  // Keep both: the cut retake comes back; the take that replaced it stays (a plain restore of this line).
  const onKeepBoth = useCallback((segmentId: string) => saver?.toggle(segmentId), [saver]);
  const onOverlayHidden = useCallback(
    (overlayId: string, hidden: boolean) => {
      if (activeVariant) saver?.edit({ type: 'overlayHidden', variantId: activeVariant, overlayId, hidden });
    },
    [saver, activeVariant],
  );

  // ---- stepping through cuts ----
  const [stepped, setStepped] = useState<string | null>(null);
  // The cut being played, while it plays (or the last one stepped to, while paused on it).
  const currentCut = sp.snapshot.audition?.segmentId ?? (stepped && cuts.some((c) => c.segmentId === stepped) ? stepped : null);
  const onStepCut = (dir: 1 | -1) => {
    const target = stepCut(edl, cuts, currentCut, dir, sp.snapshot.segmentId);
    const row = target ? rows.find((r) => r.segmentId === target.segmentId) : undefined;
    if (!target || !row) return;
    setStepped(target.segmentId);
    const y = rowY.current.get(target.segmentId);
    if (y !== undefined) scrollRef.current?.scrollTo({ y: Math.max(0, y - 54), animated: true });
    sp.playSpan(target.segmentId, cutContextSpan(row, proxySec));
  };
  const onSeek = useCallback(
    (row: TranscriptRow) => {
      sp.seekToSegment(row.segmentId, row);
      sp.play();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sp.seekToSegment, sp.play],
  );

  const wasPlaying = useRef(false);
  const scrubbing = useRef(false);
  const onScrub = (t: ScrubTarget) => {
    if (!scrubbing.current) {
      scrubbing.current = true;
      wasPlaying.current = sp.playing;
      if (sp.playing) sp.pause();
    }
    const seg = edl.segments.find((s) => s.id === t.segmentId)!;
    const offset = offsets[seg.clipId] ?? 0;
    sp.seekToSegment(t.segmentId, { proxyStart: offset + seg.start, proxyEnd: offset + seg.end }, t.offsetSec);
  };
  const onScrubEnd = (t: ScrubTarget | null) => {
    scrubbing.current = false;
    // Landing on a cut plays it so the creator can hear what was removed.
    const inRanges = t ? ranges.some((r) => r.segmentId === t.segmentId) : false;
    if (wasPlaying.current || (t && !inRanges)) sp.play();
  };

  // ---- preview with effects ----
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<unknown>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const preview = useRender(previewId);
  const requestPreview = async () => {
    setPreviewError(null);
    try {
      // A preview of an older revision than the screen shows would mislead.
      if (saver && !(await saver.flush())) throw saver.getState().error ?? new Error("Your last changes aren't saved yet.");
      sp.pause();
      const res = await getApi().createRenders(video.id, { quality: 'preview', variantIds: [activeVariant] });
      setPreviewId(res.renders[0]?.id ?? null);
      setPreviewOpen(true);
    } catch (e) {
      setPreviewError(e);
    }
  };
  const previewReady = preview.data?.status === 'done' && !!preview.data.url;
  const previewBusy = !!previewId && !previewReady && preview.data?.status !== 'failed';

  // Export renders what the server has. Leaving before the last taps are saved would export an older
  // revision than the one on screen, so it waits for the save (retrying passing failures) and says so if it
  // cannot. The revision reviewed goes along, and Export checks the server still has it.
  const [leaving, setLeaving] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  const looksGood = async () => {
    sp.pause();
    setBlocked(null);
    setLeaving(true);
    try {
      const ok = saver ? await saver.saveUntilDone(3) : true;
      if (!ok) {
        setBlocked(`Your last changes aren't saved yet, so Kilo won't export an older version. ${errorMessage(saver?.getState().error)} Kilo keeps trying; tap Looks good again in a moment.`);
        return;
      }
      const revision = saver?.getState().server.revision ?? video.edl.revision;
      router.push(`/export/${video.id}?rev=${revision}`);
    } finally {
      setLeaving(false);
    }
  };

  const saveError = state?.error;
  // No words at all (a muted microphone, music only): nothing could be cut by what was said.
  // The server's notice when it sends one; until then, worked out from the transcripts.
  const noSpeech =
    video.notice ??
    (video.transcripts.length > 0 && video.transcripts.every((t) => t.words.length === 0)
      ? "Kilo couldn't hear any speech in this video, so it kept everything. Check that your microphone was on, or tap the pauses below to cut them yourself."
      : null);

  return (
    <Screen
      scroll={false}
      gap={14}
      footer={
        <View style={styles.actions}>
          <PillButton variant="secondary" label="B-roll" style={{ flex: 1 }} onPress={() => router.push(`/broll/${video.id}`)} />
          <PillButton label="Looks good" height={52} style={{ flex: 2 }} onPress={looksGood} loading={leaving} testID="looks-good" />
        </View>
      }
    >
      <Header title={video.title} meta={position} size="titleSm" />

      {edl.variants.length > 1 ? (
        <SegmentedControl
          segments={edl.variants.map((x) => ({ value: x.id, label: x.label }))}
          value={activeVariant ?? edl.variants[0]!.id}
          onChange={(id) => setVariantId(id)}
          accessibilityLabel="Opening"
        />
      ) : null}

      <View style={styles.top}>
        <View style={[styles.player, shadow.player]}>
          <VideoView player={sp.player} style={styles.video} contentFit="cover" nativeControls={false} />
          <Pressable
            onPress={sp.toggle}
            accessibilityRole="button"
            accessibilityLabel={sp.playing ? 'Pause' : 'Play preview'}
            style={styles.playHit}
            testID="play"
          >
            {!sp.playing ? (
              <View style={styles.playButton}>
                <Icon name="play" size={18} />
              </View>
            ) : null}
          </Pressable>
          {sp.snapshot.audition ? (
            <View style={styles.auditionTag} pointerEvents="none">
              <Text variant="label" weight={600} tone="white">
                Playing a cut
              </Text>
            </View>
          ) : null}
        </View>
        <View style={styles.side}>
          <View style={{ gap: 4 }}>
            <Text variant="secondary" tone="muted">
              Final length
            </Text>
            <Text variant="display" testID="final-length" accessibilityLabel={`Final length ${formatDuration(stats.keptSec)}`}>
              {formatDuration(stats.keptSec)}
            </Text>
            <Text variant="secondary" tone="muted" testID="recorded-length">
              from {formatDuration(stats.totalSec)} recorded
            </Text>
            <PreviewLink
              busy={previewBusy}
              progress={preview.data?.progress ?? 0}
              failed={preview.data?.status === 'failed' || !!previewError}
              error={previewError ?? preview.data?.error}
              ready={previewReady}
              onPress={previewReady ? () => setPreviewOpen(true) : requestPreview}
            />
          </View>
          <View style={{ gap: 6 }}>
            <Legend kept />
            <Legend count={stats.cutCount} />
            {saveError ? (
              <Pressable onPress={() => void saver?.retry()} accessibilityRole="button" accessibilityLabel="Couldn't save. Tap to try again">
                <Text variant="secondary" tone="cut">
                  Couldn't save. Tap to retry.
                </Text>
              </Pressable>
            ) : (
              <Text variant="secondary" tone="muted">
                {state?.saving ? 'Saving…' : 'Tap a line to put it back or cut it.'}
              </Text>
            )}
          </View>
        </View>
      </View>

      {blocked ? (
        <View style={styles.notice} testID="save-blocked" accessibilityLiveRegion="assertive">
          <Icon name="alert" size={16} color={color.cut} />
          <Text variant="secondary" tone="cut" style={{ flex: 1 }}>
            {blocked}
          </Text>
        </View>
      ) : null}

      {noSpeech ? (
        <View style={styles.notice} testID="no-speech" accessibilityLiveRegion="polite">
          <Icon name="alert" size={16} color={color.cut} />
          <Text variant="secondary" style={{ flex: 1 }}>
            {noSpeech}
          </Text>
        </View>
      ) : null}

      <ScrubStrip
        edl={edl}
        clipOffsets={offsets}
        proxyTime={sp.snapshot.proxyTime}
        segmentId={sp.snapshot.segmentId}
        totalSec={stats.totalSec}
        onScrub={onScrub}
        onScrubEnd={onScrubEnd}
        marked={marked}
      />

      <View style={styles.tools}>
        <CaptionsControl captions={edl.captions} onChange={(captions) => saver?.edit({ type: 'captions', captions })} />
        <CutStepper lines={cuts} current={currentCut} summary={cutSummary(cuts)} onStep={onStepCut} />
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.list}
        contentContainerStyle={{ gap: 6, paddingBottom: 8 }}
        onScrollBeginDrag={() => (userScrolling.current = true)}
        onMomentumScrollEnd={() => (userScrolling.current = false)}
        onScrollEndDrag={() => setTimeout(() => (userScrolling.current = false), 1500)}
        testID="transcript"
      >
        {rows.map((row) => (
          <View key={row.segmentId} onLayout={(e) => rowY.current.set(row.segmentId, e.nativeEvent.layout.y)}>
            <TranscriptRowView
              row={row}
              active={row.segmentId === activeId}
              onToggle={onToggle}
              onSeek={onSeek}
              hasOverlay={marked.has(row.segmentId)}
              why={why.get(row.segmentId)}
              onKeepBoth={!row.keep && keepBothIds.has(row.segmentId) ? onKeepBoth : undefined}
              overlays={overlayInfo.get(row.segmentId)}
              onOverlayHidden={activeVariant ? onOverlayHidden : undefined}
            />
          </View>
        ))}
      </ScrollView>

      <VideoModal url={previewOpen && previewReady ? preview.data!.url : null} title={`${video.title}, with effects`} onClose={() => setPreviewOpen(false)} />
    </Screen>
  );
}

function Legend({ kept, count }: { kept?: boolean; count?: number }) {
  return (
    <View style={styles.legend}>
      <View style={[styles.swatch, kept ? { backgroundColor: color.accent } : { backgroundColor: color.white, borderWidth: 1, borderColor: color.cut }]} />
      <Text variant="secondary">{kept ? 'Kept' : `Cut (${count ?? 0})`}</Text>
    </View>
  );
}

/**
 * "Preview with effects": the skip-player shows cuts only; zooms, B-roll and
 * graphics need a rendered preview.
 */
function PreviewLink({ busy, progress, failed, error, ready, onPress }: { busy: boolean; progress: number; failed: boolean; error: unknown; ready: boolean; onPress: () => void }) {
  const label = busy ? `Preview ${Math.round(progress * 100)}%` : ready ? 'Watch with effects' : failed ? 'Preview failed, retry' : 'Preview with effects';
  const spoken = busy
    ? `Preparing a preview with zooms, B-roll and graphics, ${Math.round(progress * 100)} percent`
    : failed
      ? `Preview failed: ${errorMessage(error)}. Tap to try again`
      : `${label}. Zooms, B-roll and graphics only show in a rendered preview`;
  return (
    <Pressable
      onPress={busy ? undefined : onPress}
      accessibilityRole="button"
      accessibilityLabel={spoken}
      accessibilityState={{ busy }}
      style={({ pressed }) => [styles.previewLink, pressed && { opacity: 0.6 }]}
      testID="preview-effects"
    >
      <Icon name="sparkle" size={16} color={failed ? color.cut : color.accent} />
      <View style={{ flex: 1, gap: 4 }}>
        <Text variant="secondary" weight={600} tone={failed ? 'cut' : 'accent'} numberOfLines={1}>
          {label}
        </Text>
        {busy ? <ProgressBar value={progress} height={3} /> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', gap: 14, alignItems: 'stretch' },
  player: { width: 118, height: 210, borderRadius: 16, backgroundColor: color.player, overflow: 'hidden', flexShrink: 0 },
  // Explicit size: on web the <video> otherwise takes its intrinsic size.
  video: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' },
  playHit: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  playButton: { width: 48, height: 48, borderRadius: 24, backgroundColor: color.white, alignItems: 'center', justifyContent: 'center' },
  auditionTag: { position: 'absolute', left: 6, right: 6, bottom: 6, borderRadius: 8, backgroundColor: 'rgba(180,68,30,0.9)', paddingVertical: 4, alignItems: 'center' },
  side: { flex: 1, justifyContent: 'space-between' },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  swatch: { width: 12, height: 12, borderRadius: 3 },
  list: { flex: 1, minHeight: 0 },
  tools: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  actions: { flexDirection: 'row', gap: 10 },
  notice: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', padding: 12, borderRadius: 14, backgroundColor: color.white, borderWidth: 1, borderColor: color.hairline },
  previewLink: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, marginTop: 2 },
});
