import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActionSheetIOS, ActivityIndicator, Alert, Platform, Pressable, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { VideoView } from 'expo-video';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import Animated, { Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';
import { edlStats, getTemplate, playbackRanges, type Edl, type Overlay, type VideoDetail } from '@kilo/edl';
import { keys, useBatch, useRender, useRetryVideo, useVideo } from '@/api/queries';
import { getApi } from '@/api/client';
import { errorMessage } from '@/api/errors';
import { formatDuration, plural, statusLabel } from '@/lib/format';
import { useEdlSaver } from '@/review/useEdlSaver';
import { useSkipPlayer } from '@/review/useSkipPlayer';
import { useStableUrl } from '@/lib/stableUrl';
import { ScrubStrip } from '@/review/ScrubStrip';
import type { RowActions } from '@/review/TranscriptRowView';
import { TranscriptList, type TranscriptListHandle } from '@/review/TranscriptList';
import { CutStepper } from '@/review/CutStepper';
import { RollingNumber } from '@/review/RollingNumber';
import { TracedThumb } from '@/review/TracedThumb';
import { buildRowModels, stabilizeRowModels, type RowModel, type RowOverlayInfo } from '@/review/rowModels';
import { cutContextSpan, cutLines, cutReasonText, cutSummary, proxyDuration, stepCut } from '@/review/cuts';
import { markedSegments, rowOverlays } from '@/review/variantOverlays';
import { activeRowId, transcriptRows, type TranscriptRow } from '@/review/rows';
import type { ScrubTarget } from '@/review/scrub';
import { VideoModal } from '@/components/VideoModal';
import { CaptionsControl } from '@/review/CaptionsControl';
import {
  ActionMenu,
  Card,
  Chip,
  ErrorState,
  Glass,
  PillButton,
  PressableScale,
  ProgressBar,
  Screen,
  SegmentedControl,
  Skeleton,
  SymbolIcon,
  Text,
  ThemeScope,
  haptic,
  makeStyles,
  motionHaptics,
  space,
  toast,
  useColors,
  useTheme,
  useToastInset,
  type MenuItem,
  type ScreenHeaderConfig,
} from '@/ui';

const ios = Platform.OS === 'ios';
const native = Platform.OS !== 'web';
const standard = Easing.bezier(0.2, 0.8, 0.2, 1);

/** The floating toolbar (design brief 4.6): 64 high, inset 12, radius 28. */
const TOOLBAR_H = 64;
const TOOLBAR_INSET = 12;
/** The creator touched the transcript: auto-scroll waits this long after. */
const AUTO_SCROLL_PAUSE_MS = 1500;

type ReadyVideo = VideoDetail & { edl: Edl; proxy: NonNullable<VideoDetail['proxy']> };

// ---- Header ---------------------------------------------------------------------------------

/**
 * Inline title with "3 of 30" and the ellipsis menu. iOS: the native bar (glass bar buttons, a
 * native menu). Elsewhere the in-content header, where the position stays beside the menu.
 */
function reviewHeader(title: string, position: string | undefined, menu: MenuItem[] | null): ScreenHeaderConfig {
  if (ios || !menu) return { title, meta: position, size: 'titleSm', actions: menu ? [{ label: 'More', icon: 'more', onPress: () => undefined, menu, testID: 'review-menu' }] : undefined };
  return {
    title,
    size: 'titleSm',
    right: (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {position ? (
          <Text variant="secondary" tone="muted" tabular>
            {position}
          </Text>
        ) : null}
        <ActionMenu icon="more" label="More" items={menu} testID="review-menu" />
      </View>
    ),
  };
}

function confirm(title: string, message: string, action: string, destructive: boolean, onYes: () => void) {
  if (Platform.OS === 'web') {
    if ((globalThis as { confirm?: (m: string) => boolean }).confirm?.(`${title}\n\n${message}`)) onYes();
    return;
  }
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: action, style: destructive ? 'destructive' : 'default', onPress: onYes },
  ]);
}

// ---- Route ----------------------------------------------------------------------------------

/** Review (design brief 4.6): pinned player block, the transcript, the floating glass toolbar. */
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
      <Screen appearance="auto" scroll={false} header={reviewHeader(title, undefined, null)}>
        <ReviewSkeleton />
      </Screen>
    );
  }
  if (!v) {
    return (
      <Screen appearance="auto" header={reviewHeader(title, undefined, null)}>
        <ErrorState error={video.error} onRetry={() => void video.refetch()} />
      </Screen>
    );
  }
  if (!v.edl || !v.proxy) return <NotReady video={v} position={position} />;
  return <ReviewBody video={v as ReadyVideo} position={position} />;
}

// ---- Loading, not ready, failed ----------------------------------------------------------------

/** The pinned block's shape (player, three lines, strip), then eight rows. */
function ReviewSkeleton() {
  return (
    <View style={{ gap: 14 }} accessibilityLabel="Loading" accessibilityRole="progressbar">
      <View style={{ flexDirection: 'row', gap: 14 }}>
        <Skeleton width={120} height={213} radius={16} />
        <View style={{ flex: 1, gap: 10, paddingTop: 4 }}>
          <Skeleton width="50%" height={12} />
          <Skeleton width="70%" height={36} />
          <Skeleton width="60%" height={12} />
        </View>
      </View>
      <Skeleton height={28} radius={5} />
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} height={48} radius={14} />
      ))}
    </View>
  );
}

function NotReady({ video, position }: { video: VideoDetail; position?: string }) {
  const retry = useRetryVideo();
  const c = useColors();
  const failed = video.status === 'failed';
  const pct = video.progress != null ? Math.round(video.progress * 100) : null;
  return (
    <Screen appearance="auto" header={reviewHeader(video.title, position, null)} contentStyle={{ flexGrow: 1, justifyContent: 'center' }}>
      <Card gap={12} padding={24} style={{ alignItems: 'center' }} testID={failed ? 'review-failed' : 'review-not-ready'}>
        <TracedThumb uri={video.thumbnailUrl} cacheKey={video.id} progress={failed ? null : (video.progress ?? 0)} />
        {failed ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
            <SymbolIcon name="alert" filled size={20} color={c.cut} />
            <Text variant="button" center>
              Kilo couldn't edit this video
            </Text>
          </View>
        ) : (
          <Text variant="button" center tabular style={{ marginTop: 4 }} accessibilityLiveRegion="polite">
            {statusLabel(video.status)}…{pct !== null ? ` ${pct}%` : ''}
          </Text>
        )}
        <Text variant="secondary" tone="muted" center>
          {failed ? (video.error ?? 'Something went wrong while editing.') : 'This page updates by itself when the edit is ready.'}
        </Text>
        {failed ? (
          <PillButton variant="secondary" surface="content" height={44} icon="refresh" label="Try again" loading={retry.isPending} onPress={() => retry.mutate(video.id)} />
        ) : (
          <View style={{ alignSelf: 'stretch' }}>
            <ProgressBar value={video.progress ?? 0} height={3} accessibilityLabel={statusLabel(video.status)} />
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

// ---- The review ------------------------------------------------------------------------------

const useStyles = makeStyles((t) => ({
  root: { flex: 1 },
  top: { flexDirection: 'row', gap: 14, alignItems: 'stretch' },
  player: { width: 120, height: 213, borderRadius: 16, borderCurve: 'continuous', backgroundColor: t.color.player, overflow: 'hidden', flexShrink: 0, ...t.shadow.player },
  // Explicit size: on web the <video> otherwise takes its intrinsic size.
  video: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' },
  veil: { ...StyleSheet.absoluteFill, backgroundColor: t.color.player },
  playHit: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  playButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  playGlyph: { marginLeft: 3 },
  auditionTag: { position: 'absolute', left: 8, right: 8, bottom: 8, height: 24, borderRadius: 12, backgroundColor: t.scheme === 'dark' ? 'rgba(240,135,90,0.9)' : 'rgba(180,68,30,0.9)', alignItems: 'center', justifyContent: 'center' },
  side: { flex: 1, justifyContent: 'space-between', paddingVertical: 2 },
  length: { fontFamily: 'Inter_700Bold', fontSize: 40, letterSpacing: -1.5, color: t.color.ink },
  legendRow: { flexDirection: 'row', gap: 14, flexWrap: 'wrap' },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  swatch: { width: 12, height: 12, borderRadius: 3 },
  swatchKept: { backgroundColor: t.color.accent },
  swatchCut: { backgroundColor: t.scheme === 'dark' ? 'transparent' : t.color.fill, borderWidth: 1, borderColor: t.color.cut },
  tools: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  saveState: { marginLeft: 'auto', minHeight: 44, justifyContent: 'center' },
  notice: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  previewLink: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44 },
  list: { flex: 1, minHeight: 0, marginHorizontal: -space.gutter },
  toolbar: { position: 'absolute', left: TOOLBAR_INSET, right: TOOLBAR_INSET, height: TOOLBAR_H, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  looksGood: { height: 48, minWidth: 148, borderRadius: 24, paddingHorizontal: 22, alignItems: 'center', justifyContent: 'center', overflow: 'visible', ...t.shadow.gloss },
}));

function ReviewBody({ video, position }: { video: ReadyVideo; position?: string }) {
  const s = useStyles();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const { saver, state } = useEdlSaver(video.id, video.edl);
  const edl = state?.local ?? video.edl;
  const offsets = video.proxy.clipOffsets;

  const [variantId, setVariantId] = useState<string | null>(edl.variants[0]?.id ?? null);
  const activeVariant = variantId && edl.variants.some((x) => x.id === variantId) ? variantId : (edl.variants[0]?.id ?? null);

  const ranges = useMemo(() => playbackRanges(edl, offsets, activeVariant), [edl, offsets, activeVariant]);
  const stats = useMemo(() => edlStats(edl, activeVariant), [edl, activeVariant]);
  const rows = useMemo(() => transcriptRows(edl, offsets), [edl, offsets]);
  // Lines with B-roll or a graphic in the cut being watched get a marker: what that version shows.
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
  // Stable row models: a tap changes one object, so only that row re-renders.
  const modelsRef = useRef<readonly RowModel[] | null>(null);
  const models = useMemo(() => {
    const next = stabilizeRowModels(modelsRef.current, buildRowModels(rows, why, keepBothIds, marked, overlayInfo));
    modelsRef.current = next;
    return next;
  }, [rows, why, keepBothIds, marked, overlayInfo]);

  // The proxy link is re-signed on every refetch; keep one until it stops working, so the player never reloads.
  const proxyUrl = useStableUrl(video.proxy.url);
  const refetchVideo = useVideo(video.id).refetch;
  const sp = useSkipPlayer(proxyUrl.url, ranges, {
    onError: () => {
      if (!proxyUrl.renew()) void refetchVideo().then(() => proxyUrl.renew());
    },
  });
  const activeId = activeRowId(edl, rows, sp.snapshot.segmentId);

  // A different opening is a different video: start it from its own beginning, cross-fading the player.
  const veil = useSharedValue(0);
  const shownVariant = useRef(activeVariant);
  useEffect(() => {
    if (shownVariant.current === activeVariant) return;
    shownVariant.current = activeVariant;
    sp.seekToOutput(0);
    if (native) {
      veil.value = 1;
      veil.value = withTiming(0, { duration: 120, easing: standard, reduceMotion: ReduceMotion.Never });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeVariant]);
  const veilStyle = useAnimatedStyle(() => ({ opacity: veil.value }));

  // ---- transcript: auto-scroll, cut / restore motion, stepper highlight ----
  const list = useRef<TranscriptListHandle>(null);
  const touch = useRef({ touching: false, at: 0 });
  const onTouchState = useCallback((touching: boolean) => {
    const t = touch.current;
    if (!touching && t.touching) t.at = Date.now();
    t.touching = touching;
  }, []);
  useEffect(() => {
    const t = touch.current;
    if (!sp.playing || !activeId || t.touching || Date.now() - t.at < AUTO_SCROLL_PAUSE_MS) return;
    list.current?.scrollToRow(activeId);
  }, [activeId, sp.playing]);

  const nonce = useRef(0);
  const [pulse, setPulse] = useState<{ id: string; n: number } | null>(null);
  const [flash, setFlash] = useState<{ id: string; n: number } | null>(null);
  const edited = useRef<'no' | 'edited' | 'saving' | 'told'>('no');

  // ---- stepping through cuts ----
  const [stepped, setStepped] = useState<string | null>(null);
  // The cut being played, while it plays (or the last one stepped to, while paused on it).
  const currentCut = sp.snapshot.audition?.segmentId ?? (stepped && cuts.some((c) => c.segmentId === stepped) ? stepped : null);

  // Everything the rows and the toolbar call, read through one ref so the handlers never change.
  const latest = useRef({ saver, rows, models, activeVariant, sp, cuts, currentCut, edl, proxySec });
  latest.current = { saver, rows, models, activeVariant, sp, cuts, currentCut, edl, proxySec };

  const actions = useMemo<RowActions>(() => {
    const toggle = (segmentId: string) => {
      const L = latest.current;
      const row = L.rows.find((r) => r.segmentId === segmentId);
      if (!row || !L.saver) return;
      haptic(row.keep ? motionHaptics.cut : motionHaptics.restore);
      L.saver.toggle(segmentId);
      if (edited.current === 'no') edited.current = 'edited';
      setPulse({ id: segmentId, n: ++nonce.current });
    };
    const seek = (row: TranscriptRow) => {
      const { sp: p } = latest.current;
      p.seekToSegment(row.segmentId, row);
      p.play();
    };
    const overlayHidden = (overlayId: string, hidden: boolean) => {
      const L = latest.current;
      if (L.activeVariant) L.saver?.edit({ type: 'overlayHidden', variantId: L.activeVariant, overlayId, hidden });
    };
    return {
      toggle,
      seek,
      // Keep both: the cut retake comes back; the take that replaced it stays (a plain restore of this line).
      keepBoth: toggle,
      overlayHidden,
      menu: (m: RowModel) => rowMenu(m, { toggle, seek, overlayHidden }),
      // Only the motion that ended clears its state: a newer tap on the same row keeps its own.
      pulseDone: (id, n) => setPulse((p) => (p?.id === id && p.n === n ? null : p)),
      flashDone: (id, n) => setFlash((f) => (f?.id === id && f.n === n ? null : f)),
    };
  }, []);

  const onStepCut = useCallback((dir: 1 | -1) => {
    const L = latest.current;
    const target = stepCut(L.edl, L.cuts, L.currentCut, dir, L.sp.snapshot.segmentId);
    const row = target ? L.rows.find((r) => r.segmentId === target.segmentId) : undefined;
    if (!target || !row) return;
    setStepped(target.segmentId);
    list.current?.scrollToRow(target.segmentId);
    setFlash({ id: target.segmentId, n: ++nonce.current });
    L.sp.playSpan(target.segmentId, cutContextSpan(row, L.proxySec));
  }, []);

  // ---- the scrub strip ----
  const wasPlaying = useRef(false);
  const scrubbing = useRef(false);
  const onScrub = (t: ScrubTarget) => {
    if (!scrubbing.current) {
      scrubbing.current = true;
      wasPlaying.current = sp.playing;
      if (sp.playing) sp.pause();
    }
    const seg = edl.segments.find((x) => x.id === t.segmentId)!;
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
  const openPreview = () => (previewReady ? setPreviewOpen(true) : previewBusy ? undefined : void requestPreview());

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
        toast.error("Couldn't save your last changes", { action: { label: 'Retry', onPress: () => void saver?.retry() } });
        return;
      }
      const revision = saver?.getState().server.revision ?? video.edl.revision;
      router.push(`/export/${video.id}?rev=${revision}`);
    } finally {
      setLeaving(false);
    }
  };

  // "Saved. You cut 1:49." once, after the first edit of this visit is saved.
  const saving = !!state?.saving;
  const saveError = state?.error;
  const settled = !!state && !saving && !saveError && Object.keys(state.pending).length === 0 && state.edits.length === 0;
  useEffect(() => {
    if (edited.current === 'edited' && saving) edited.current = 'saving';
    if (edited.current === 'saving' && settled) {
      edited.current = 'told';
      toast.show({ kind: 'success', text: `Saved. You cut ${formatDuration(Math.max(0, stats.totalSec - stats.keptSec))}.` });
    }
  }, [saving, settled, stats.totalSec, stats.keptSec]);

  // No words at all (a muted microphone, music only): nothing could be cut by what was said.
  const noSpeech =
    video.notice ??
    (video.transcripts.length > 0 && video.transcripts.every((t) => t.words.length === 0)
      ? "Kilo couldn't hear any speech in this video, so it kept everything. Check that your microphone was on, or tap the pauses below to cut them yourself."
      : null);

  const menu = useMemo<MenuItem[]>(
    () => [
      { label: 'Preview with effects', icon: 'sparkle', onPress: () => openPreviewRef.current() },
      { label: 'Edit B-roll', icon: 'broll', onPress: () => router.push(`/broll/${video.id}`) },
      {
        label: 'Redo the edit',
        subtitle: 'Places B-roll, graphics and openings again',
        icon: 'refresh',
        onPress: () =>
          confirm('Redo the edit?', 'Kilo places B-roll, graphics and openings again. Your cuts stay as they are.', 'Redo', false, () => {
            getApi()
              .replan(video.id, { passes: ['broll', 'graphics', 'variants'] })
              .then(() => qc.invalidateQueries({ queryKey: keys.video(video.id) }))
              .catch((e: unknown) => toast.error(errorMessage(e)));
          }),
      },
      {
        label: 'Delete video',
        icon: 'trash',
        destructive: true,
        onPress: () =>
          confirm(`Delete "${video.title}"?`, 'The video and its edit are deleted. This cannot be undone.', 'Delete', true, () => {
            getApi()
              .deleteVideo(video.id)
              .then(() => {
                haptic(motionHaptics.remove);
                void qc.invalidateQueries({ queryKey: keys.home });
                void qc.invalidateQueries({ queryKey: keys.batch(video.batchId) });
                if (router.canGoBack()) router.back();
                else router.replace('/');
              })
              .catch((e: unknown) => toast.error(errorMessage(e)));
          }),
      },
    ],
    [video.id, video.title, video.batchId, qc],
  );
  const openPreviewRef = useRef(openPreview);
  openPreviewRef.current = openPreview;

  const onCaptions = useCallback((captions: Edl['captions']) => saver?.edit({ type: 'captions', captions }), [saver]);
  const brollCount = edl.overlays.filter((o) => o.type === 'broll').length;
  const toolbarBottom = Math.max(insets.bottom, TOOLBAR_INSET);
  useToastInset(toolbarBottom + TOOLBAR_H);

  return (
    <ThemeScope appearance="auto">
      <View style={s.root}>
        <Screen appearance="auto" scroll={false} gap={12} contentStyle={{ paddingBottom: 0 }} header={reviewHeader(video.title, position, menu)}>
          {edl.variants.length > 1 ? (
            <SegmentedControl
              segments={edl.variants.map((x) => ({ value: x.id, label: x.label }))}
              value={activeVariant ?? edl.variants[0]!.id}
              onChange={(next) => setVariantId(next)}
              accessibilityLabel="Opening"
            />
          ) : null}

          <View style={s.top}>
            <View style={s.player}>
              <VideoView player={sp.player} style={s.video} contentFit="cover" nativeControls={false} />
              {native ? <Animated.View pointerEvents="none" style={[s.veil, veilStyle]} /> : null}
              <Pressable
                onPress={sp.toggle}
                onLongPress={native ? openPreview : undefined}
                accessibilityRole="button"
                accessibilityLabel={sp.playing ? 'Pause' : 'Play preview'}
                accessibilityHint={native ? 'Long press to watch it with effects' : undefined}
                style={s.playHit}
                testID="play"
              >
                {!sp.playing ? (
                  <Glass kind="button" variant="clear" appearance="dark" radius={24} style={s.playButton}>
                    <View style={s.playGlyph}>
                      <SymbolIcon name="play" size={18} color="#FFFFFF" />
                    </View>
                  </Glass>
                ) : null}
              </Pressable>
              {sp.snapshot.audition ? (
                <View style={s.auditionTag} pointerEvents="none">
                  <Text variant="label" weight={600} tone="white">
                    Playing a cut
                  </Text>
                </View>
              ) : null}
            </View>
            <View style={s.side}>
              <View style={{ gap: 2 }}>
                <Text variant="secondary" tone="muted">
                  Final length
                </Text>
                <RollingNumber text={formatDuration(stats.keptSec)} style={s.length} lineHeight={44} accessibilityLabel={`Final length ${formatDuration(stats.keptSec)}`} testID="final-length" />
                <Text variant="secondary" tone="muted" testID="recorded-length" tabular>
                  from {formatDuration(stats.totalSec)} recorded
                </Text>
                <PreviewLink
                  busy={previewBusy}
                  progress={preview.data?.progress ?? 0}
                  failed={preview.data?.status === 'failed' || !!previewError}
                  error={previewError ?? preview.data?.error}
                  ready={previewReady}
                  onPress={openPreview}
                />
              </View>
              <View style={s.legendRow}>
                <View style={s.legend}>
                  <View style={[s.swatch, s.swatchKept]} />
                  <Text variant="label">Kept</Text>
                </View>
                <View style={s.legend}>
                  <View style={[s.swatch, s.swatchCut]} />
                  <Text variant="label" tabular>{`Cut (${stats.cutCount})`}</Text>
                </View>
              </View>
            </View>
          </View>

          <ScrubStrip
            edl={edl}
            clipOffsets={offsets}
            proxyTime={sp.snapshot.proxyTime}
            segmentId={sp.snapshot.segmentId}
            time={sp.time}
            totalSec={stats.totalSec}
            onScrub={onScrub}
            onScrubEnd={onScrubEnd}
            marked={marked}
            pulse={pulse}
          />

          <View style={s.tools}>
            <CaptionsControl captions={edl.captions} onChange={onCaptions} />
            <Chip
              label={brollCount ? `B-roll ${brollCount}` : 'B-roll'}
              icon="broll"
              onPress={() => router.push(`/broll/${video.id}`)}
              accessibilityLabel="B-roll"
              accessibilityHint={brollCount ? `${plural(brollCount, 'clip')} placed. Opens B-roll` : 'Opens B-roll'}
              testID="broll-chip"
            />
            <View style={s.saveState}>
              <SaveState saving={saving} error={!!saveError} onRetry={() => void saver?.retry()} />
            </View>
          </View>

          {blocked ? (
            <Card padding={12} flat style={s.notice} testID="save-blocked">
              <View style={s.notice} accessibilityLiveRegion="assertive">
                <SymbolIcon name="alert" size={16} color={c.cut} />
                <Text variant="secondary" tone="cut" style={{ flex: 1 }}>
                  {blocked}
                </Text>
              </View>
            </Card>
          ) : null}

          {noSpeech ? (
            <Card padding={12} flat testID="no-speech">
              <View style={s.notice} accessibilityLiveRegion="polite">
                <SymbolIcon name="alert" size={16} color={c.cut} />
                <Text variant="secondary" style={{ flex: 1 }}>
                  {noSpeech}
                </Text>
              </View>
            </Card>
          ) : null}

          <View style={s.list}>
            <TranscriptList
              ref={list}
              models={models}
              activeId={activeId}
              pulse={pulse}
              flash={flash}
              actions={actions}
              bottomPadding={toolbarBottom + TOOLBAR_H + 16}
              onTouchState={onTouchState}
            />
          </View>
        </Screen>

        <Glass kind="bar" style={[s.toolbar, { bottom: toolbarBottom }]} testID="review-toolbar">
          <CutStepper lines={cuts} current={currentCut} summary={cutSummary(cuts)} onStep={onStepCut} />
          <LooksGood loading={leaving} onPress={() => void looksGood()} />
        </Glass>

        <VideoModal url={previewOpen && previewReady ? preview.data!.url : null} title={`${video.title}, with effects`} onClose={() => setPreviewOpen(false)} />
      </View>
    </ThemeScope>
  );
}

// ---- Row menu (long press) ---------------------------------------------------------------------

function rowMenu(m: RowModel, a: { toggle: (id: string) => void; seek: (row: TranscriptRow) => void; overlayHidden: (id: string, hidden: boolean) => void }) {
  const { row } = m;
  const items: { label: string; run: () => void; destructive?: boolean }[] = [
    { label: 'Play this line', run: () => a.seek(row) },
    { label: row.keep ? 'Cut' : 'Put back', run: () => a.toggle(row.segmentId), destructive: row.keep },
  ];
  if (m.keepBoth) items.push({ label: 'Keep both', run: () => a.toggle(row.segmentId) });
  const shown = m.overlays?.shown[0];
  const hidden = m.overlays?.hidden[0];
  if (shown && m.overlays) items.push({ label: `Hide ${shown.label} in ${m.overlays.variantLabel}`, run: () => a.overlayHidden(shown.id, true) });
  else if (hidden && m.overlays) items.push({ label: `Show ${hidden.label} in ${m.overlays.variantLabel}`, run: () => a.overlayHidden(hidden.id, false) });
  if (ios) {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: row.text.length > 80 ? `${row.text.slice(0, 79)}…` : row.text,
        options: [...items.map((i) => i.label), 'Cancel'],
        cancelButtonIndex: items.length,
        destructiveButtonIndex: items.findIndex((i) => i.destructive),
      },
      (i) => items[i]?.run(),
    );
    return;
  }
  // Android: a dialog holds at most three choices.
  Alert.alert(row.text.length > 80 ? `${row.text.slice(0, 79)}…` : row.text, undefined, [
    ...items.slice(0, 2).map((i) => ({ text: i.label, onPress: i.run })),
    { text: 'Cancel', style: 'cancel' as const },
  ]);
}

// ---- Toolbar and small parts ---------------------------------------------------------------------

/**
 * "Looks good", the screen's one filled accent control, 48 high in the glass bar. While it waits
 * for the save the label gives way to a spinner in place and the button keeps its width.
 */
const LooksGood = memo(function LooksGood({ loading, onPress }: { loading: boolean; onPress: () => void }) {
  const s = useStyles();
  const t = useTheme();
  return (
    <PressableScale
      onPress={onPress}
      disabled={loading}
      motion="button"
      haptic={motionHaptics.primaryPress}
      accessibilityRole="button"
      accessibilityLabel="Looks good"
      accessibilityState={{ busy: loading, disabled: loading }}
      testID="looks-good"
      style={s.looksGood}
    >
      <LinearGradient colors={t.accentGloss.colors} locations={t.accentGloss.locations} style={[StyleSheet.absoluteFill, { borderRadius: 24 }]} pointerEvents="none" />
      <Text variant="button" weight={600} tone="white" style={{ fontSize: 16, opacity: loading ? 0 : 1 }} numberOfLines={1}>
        Looks good
      </Text>
      {loading ? (
        <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
          <ActivityIndicator color={t.color.onAccent} />
        </View>
      ) : null}
    </PressableScale>
  );
});

/**
 * The save state at the end of the tools row: "Saving…", then "Saved" fading out after 1.5 s
 * (on the UI thread), or "Couldn't save. Tap to retry." in `cut`.
 */
function SaveState({ saving, error, onRetry }: { saving: boolean; error: boolean; onRetry: () => void }) {
  const o = useSharedValue(0);
  const [label, setLabel] = useState<'saving' | 'saved' | null>(null);
  const was = useRef(saving);
  useEffect(() => {
    if (saving) {
      setLabel('saving');
      o.value = 1;
    } else if (was.current && !error) {
      setLabel('saved');
      o.value = 1;
      o.value = withDelay(1500, withTiming(0, { duration: 300, easing: standard, reduceMotion: ReduceMotion.Never }));
    }
    was.current = saving;
  }, [saving, error, o]);
  const style = useAnimatedStyle(() => ({ opacity: o.value }));
  if (error) {
    return (
      <Pressable onPress={onRetry} accessibilityRole="button" accessibilityLabel="Couldn't save. Tap to try again" hitSlop={8} testID="save-error">
        <Text variant="label" weight={600} tone="cut">
          Couldn't save. Tap to retry
        </Text>
      </Pressable>
    );
  }
  if (!label) return null;
  return (
    <Animated.View style={style} accessibilityLiveRegion="polite">
      <Text variant="label" tone="muted">
        {label === 'saving' ? 'Saving…' : 'Saved'}
      </Text>
    </Animated.View>
  );
}

/**
 * "Preview with effects": the skip-player shows cuts only; zooms, B-roll and graphics need a
 * rendered preview. A thin progress bar under it while it renders.
 */
function PreviewLink({ busy, progress, failed, error, ready, onPress }: { busy: boolean; progress: number; failed: boolean; error: unknown; ready: boolean; onPress: () => void }) {
  const s = useStyles();
  const c = useColors();
  const label = busy ? `Preview ${Math.round(progress * 100)}%` : ready ? 'Watch with effects' : failed ? 'Preview failed, retry' : 'Preview with effects';
  const spoken = busy
    ? `Preparing a preview with zooms, B-roll and graphics, ${Math.round(progress * 100)} percent`
    : failed
      ? `Preview failed: ${errorMessage(error)}. Tap to try again`
      : `${label}. Zooms, B-roll and graphics only show in a rendered preview`;
  return (
    <PressableScale
      onPress={busy ? undefined : onPress}
      motion="row"
      accessibilityRole="button"
      accessibilityLabel={spoken}
      accessibilityState={{ busy }}
      style={s.previewLink}
      testID="preview-effects"
    >
      <SymbolIcon name="sparkle" size={14} color={failed ? c.cut : c.accent} />
      <View style={{ flex: 1, gap: 4 }}>
        <Text variant="secondary" weight={600} tone={failed ? 'cut' : 'accent'} numberOfLines={1} tabular>
          {label}
        </Text>
        {busy ? <ProgressBar value={progress} height={3} /> : null}
      </View>
    </PressableScale>
  );
}
