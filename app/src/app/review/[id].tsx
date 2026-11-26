import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type ScrollViewInstance } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { VideoView } from 'expo-video';
import { edlStats, playbackRanges, type Edl, type VideoDetail } from '@kilo/edl';
import { useBatch, useRender, useRetryVideo, useVideo } from '@/api/queries';
import { getApi } from '@/api/client';
import { errorMessage } from '@/api/errors';
import { formatDuration, plural, statusLabel } from '@/lib/format';
import { useEdlSaver } from '@/review/useEdlSaver';
import { useSkipPlayer } from '@/review/useSkipPlayer';
import { ScrubStrip } from '@/review/ScrubStrip';
import { TranscriptRowView } from '@/review/TranscriptRowView';
import { activeRowId, transcriptRows, type TranscriptRow } from '@/review/rows';
import type { ScrubTarget } from '@/review/scrub';
import { VideoModal } from '@/components/VideoModal';
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
  const batch = useBatch(video.data?.batchId);
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
            <ProgressBar value={video.status === 'analyzing' ? 0.6 : 0.2} accessibilityLabel={statusLabel(video.status)} />
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
  const sp = useSkipPlayer(video.proxy.url, ranges);
  const activeId = activeRowId(edl, rows, sp.snapshot.segmentId);

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
      await saver?.flush();
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

  const looksGood = async () => {
    sp.pause();
    await saver?.flush();
    router.push(`/export/${video.id}`);
  };

  const saveError = state?.error;

  return (
    <Screen
      scroll={false}
      gap={14}
      footer={
        <View style={styles.actions}>
          <PillButton variant="secondary" label="B-roll" style={{ flex: 1 }} onPress={() => router.push(`/broll/${video.id}`)} />
          <PillButton label="Looks good" height={52} style={{ flex: 2 }} onPress={looksGood} testID="looks-good" />
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
          <VideoView player={sp.player} style={StyleSheet.absoluteFill} contentFit="cover" nativeControls={false} />
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

      <ScrubStrip
        edl={edl}
        clipOffsets={offsets}
        proxyTime={sp.snapshot.proxyTime}
        segmentId={sp.snapshot.segmentId}
        totalSec={stats.totalSec}
        onScrub={onScrub}
        onScrubEnd={onScrubEnd}
      />

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
            <TranscriptRowView row={row} active={row.segmentId === activeId} onToggle={onToggle} onSeek={onSeek} />
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
  playHit: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  playButton: { width: 48, height: 48, borderRadius: 24, backgroundColor: color.white, alignItems: 'center', justifyContent: 'center' },
  auditionTag: { position: 'absolute', left: 6, right: 6, bottom: 6, borderRadius: 8, backgroundColor: 'rgba(180,68,30,0.9)', paddingVertical: 4, alignItems: 'center' },
  side: { flex: 1, justifyContent: 'space-between' },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  swatch: { width: 12, height: 12, borderRadius: 3 },
  list: { flex: 1, minHeight: 0 },
  actions: { flexDirection: 'row', gap: 10 },
  previewLink: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, marginTop: 2 },
});
