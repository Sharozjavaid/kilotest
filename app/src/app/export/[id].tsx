import { useEffect, useMemo, useRef, useState } from 'react';
import { Image } from 'expo-image';
import { Alert, Platform, ScrollView, View, useWindowDimensions, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollViewInstance } from 'react-native';
import Animated, { FadeOut } from 'react-native-reanimated';
import { router, useLocalSearchParams } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import type { VideoDetail } from '@kilo/edl';
import { getApi } from '@/api/client';
import { errorMessage } from '@/api/errors';
import { keys, useBatch, useMarkPosted, useVideo } from '@/api/queries';
import { saveToCameraRoll, shareVideo } from '@/export/media';
import { nextVideoHref, revisionCheck } from '@/export/revision';
import { allRendered, exportHeadline, exportVersions, overallProgress, postedToast, saveLabel, savedToast, versionState, type Version } from '@/export/versions';
import { SaveSuccess, successDelay } from '@/export/SaveSuccess';
import { MoreActions } from '@/export/MoreActions';
import { FOOTER_BUTTON } from '@/components/sizes';
import { formatDuration } from '@/lib/format';
import { VideoModal } from '@/components/VideoModal';
import { useStableUrl } from '@/lib/stableUrl';
import {
  Card,
  Chip,
  ErrorState,
  Glass,
  LoadingBlock,
  PillButton,
  PressableScale,
  ProgressRing,
  Row,
  Screen,
  SymbolIcon,
  Text,
  haptic,
  makeStyles,
  prefersReducedMotion,
  space,
  toast,
  useColors,
  useLayoutMotion,
} from '@/ui';

const web = Platform.OS === 'web';
const native = !web;

function notify(title: string, message: string) {
  if (web) (globalThis as { alert?: (m: string) => void }).alert?.(`${title}\n\n${message}`);
  else Alert.alert(title, message);
}

const HEADER = { title: 'Ready to post' };

/** Export, "Ready to post" (design brief 4.7): final renders per version, save, share, mark as posted, next video. */
export default function ExportScreen() {
  const { id, rev } = useLocalSearchParams<{ id: string; rev?: string }>();
  const video = useVideo(id);
  const reviewed = rev !== undefined && rev !== '' && Number.isInteger(Number(rev)) ? Number(rev) : null;
  const v = video.data;

  if (video.isPending) {
    return (
      <Screen appearance="auto" header={HEADER}>
        <LoadingBlock />
      </Screen>
    );
  }
  if (!v || !v.edl) {
    return (
      <Screen appearance="auto" header={HEADER}>
        <ErrorState error={video.error ?? new Error('This video has no edit yet.')} onRetry={() => void video.refetch()} />
      </Screen>
    );
  }
  return <ExportBody video={v} reviewedRevision={reviewed} refetch={() => void video.refetch()} />;
}

const CARD_W = 180;
const CARD_H = 320;
const CARD_GAP = 16;

function ExportBody({ video, reviewedRevision, refetch }: { video: VideoDetail; reviewedRevision: number | null; refetch: () => void }) {
  const s = useStyles();
  const qc = useQueryClient();
  const edl = video.edl!;
  // For "Next video" only: not polled from here.
  const batch = useBatch(video.batchId, { poll: false });
  const posted = useMarkPosted();
  const [requestError, setRequestError] = useState<unknown>(null);
  const [selected, setSelected] = useState(0);
  const [playing, setPlaying] = useState<Version | null>(null);
  const [busy, setBusy] = useState<null | 'save' | 'share' | 'tiktok' | 'instagram'>(null);
  const [sharedTo, setSharedTo] = useState<'tiktok' | 'instagram' | null>(null);
  // The success moment: saving (with the share of versions in), then done. Once per visit, never on reload.
  const [saving, setSaving] = useState<{ done: number; finished: boolean } | null>(null);
  const [saved, setSaved] = useState(false);
  const [checkShown, setCheckShown] = useState(false);
  const requested = useRef(false);

  const versions = useMemo(() => exportVersions(edl, video.renders), [video.renders, edl]);

  // Ask for final renders when the edit has changed since the last export (or never was exported).
  const createRenders = async () => {
    setRequestError(null);
    try {
      await getApi().createRenders(video.id, { quality: 'final' });
      void qc.invalidateQueries({ queryKey: keys.video(video.id) });
      void qc.invalidateQueries({ queryKey: keys.home });
    } catch (e) {
      setRequestError(e);
    }
  };
  const check = revisionCheck(edl.revision, reviewedRevision);
  useEffect(() => {
    if (check === 'behind') refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [check]);
  useEffect(() => {
    if (requested.current) return;
    // Only the revision the creator looked at is exported.
    if (video.status === 'ready_for_review' && check === 'ok') {
      requested.current = true;
      void createRenders();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video.status, check]);

  const allDone = allRendered(versions);
  const anyFailed = versions.some((x) => x.render?.status === 'failed');
  const n = versions.length;
  const current = versions[Math.min(selected, n - 1)]!;
  const progress = overallProgress(versions);

  /** Render links are signed and expire; the screen may have been open a while, so sign them again. */
  const freshUrls = async (): Promise<Map<string, string>> => {
    const v = await getApi().getVideo(video.id);
    qc.setQueryData(keys.video(video.id), v);
    return new Map(v.renders.flatMap((r) => (r.url ? [[r.id, r.url] as const] : [])));
  };

  const saveAll = async () => {
    setBusy('save');
    setSaving({ done: 0, finished: false });
    try {
      const urls = await freshUrls();
      let count = 0;
      for (const x of versions) {
        count += await saveToCameraRoll([{ url: urls.get(x.render!.id) ?? x.render!.url!, name: `${video.title} ${x.label}` }]);
        setSaving({ done: count, finished: false });
      }
      // The ring closes, the check draws, the badge pops; the toast (with the success haptic) lands with the pop.
      setSaving({ done: count, finished: true });
      setSaved(true);
      setCheckShown(true);
      setTimeout(() => toast.success(savedToast(count, web), { haptic: true }), successDelay(prefersReducedMotion()));
      setTimeout(() => {
        setCheckShown(false);
        setSaving(null);
      }, successDelay(prefersReducedMotion()) + 2000);
    } catch (e) {
      setSaving(null);
      notify("Couldn't save", errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const send = async (to: 'share' | 'tiktok' | 'instagram') => {
    if (!current.render?.url) return;
    setBusy(to);
    try {
      const url = (await freshUrls()).get(current.render.id) ?? current.render.url;
      await shareVideo(url, `${video.title} ${current.label}`, to === 'tiktok' ? 'Send to TikTok' : to === 'instagram' ? 'Send to Instagram' : 'Share');
      if (to !== 'share') setSharedTo(to);
    } catch (e) {
      notify("Couldn't open the share sheet", errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const markPosted = (platform: 'tiktok' | 'instagram' | 'other') =>
    posted.mutate(
      { videoId: video.id, platform },
      {
        onSuccess: () => {
          haptic('selection');
          void getApi()
            .getGoal()
            .then((g) => toast.info(postedToast(g)))
            .catch(() => toast.info(postedToast(null)));
        },
      },
    );

  // ---- next video ----
  const list = batch.data?.videos ?? [];
  const idx = list.findIndex((x) => x.id === video.id);
  const next = idx >= 0 ? list[idx + 1] : undefined;
  const goNext = () => {
    // Reached from Review's "Looks good", this video's Review is the screen underneath. Leave both,
    // or every video of a batch would stay mounted under the next (30 players for 30 videos).
    if (reviewedRevision !== null && router.canDismiss()) router.dismiss();
    if (!next) return router.replace('/');
    router.replace(nextVideoHref(next));
  };

  const rendered = !!current.render?.url;
  return (
    <Screen
      appearance="auto"
      gap={16}
      header={{ ...HEADER, onBack: router.canGoBack() ? undefined : () => router.replace(`/review/${video.id}`) }}
      footerGlass
      footer={
        <>
          <PillButton
            label={saveLabel({ web, n, allDone, progress, saved })}
            // The checkmark shows for 2 s after the save (brief 4.7).
            icon={checkShown ? 'check' : 'download'}
            onPress={saveAll}
            disabled={!allDone || saved}
            loading={busy === 'save'}
            height={FOOTER_BUTTON}
          />
          <View style={s.two}>
            <PillButton variant="secondary" surface="content" label="Share" icon="share" height={44} style={s.flex} disabled={!rendered} loading={busy === 'share'} onPress={() => void send('share')} />
            <MoreActions
              style={s.flex}
              actions={[
                { label: 'Send to TikTok', onPress: () => void send('tiktok'), disabled: !rendered },
                { label: 'Send to Instagram', onPress: () => void send('instagram'), disabled: !rendered },
                { label: 'Mark as posted', onPress: () => markPosted('other'), disabled: !!video.postedAt },
              ]}
            />
          </View>
          <PillButton variant="text" label={next ? `Next video, ${idx + 2} of ${list.length}` : 'Back to Home'} onPress={goNext} />
        </>
      }
    >
      <View style={{ gap: 4 }}>
        <Text variant="headline">{exportHeadline(n, allDone)}</Text>
        <Text variant="body" tone="muted" numberOfLines={2}>
          {n > 1 ? `${video.title} · same body, ${n} different openings` : video.title}
        </Text>
      </View>

      <Pager
        versions={versions}
        selected={selected}
        onSelect={setSelected}
        onPlay={setPlaying}
        thumbnailUrl={video.thumbnailUrl}
        overlay={saving ? <SaveSuccess progress={saving.done / Math.max(1, n)} done={saving.finished} /> : null}
      />

      {check === 'ahead' && video.status === 'ready_for_review' ? (
        <Card gap={8} testID="revision-changed">
          <Text variant="body" weight={600} tone="cut">
            This edit changed since you reviewed it
          </Text>
          <Text variant="secondary" tone="muted">
            Kilo only exports the version you checked. Look over the latest edit, then tap Looks good again.
          </Text>
          <PillButton variant="secondary" surface="content" height={44} label="Review the latest edit" onPress={() => router.replace(`/review/${video.id}`)} />
        </Card>
      ) : null}

      {requestError || anyFailed ? (
        <Card gap={8}>
          <Text variant="body" weight={600} tone="cut">
            {anyFailed ? 'A version failed to export' : "Couldn't start the export"}
          </Text>
          <Text variant="secondary" tone="muted">
            {requestError ? errorMessage(requestError) : versions.find((x) => x.render?.status === 'failed')?.render?.error ?? 'Something went wrong while rendering.'}
          </Text>
          <PillButton variant="secondary" surface="content" height={44} icon="refresh" label="Try again" onPress={() => void createRenders()} />
        </Card>
      ) : null}

      <Card padding={0} paddingHorizontal={16}>
        <InfoRow label="Format" value="1080 × 1920, vertical" />
        <InfoRow divider label="Frame rate" value={`${Math.round(edl.fps)} fps, same as recorded`} />
        <InfoRow divider label="Captions" value={edl.captions.enabled ? 'Burned in' : 'Off, add in the app you post to'} />
      </Card>

      <Text variant="secondary" tone="muted">
        Share and Send to TikTok or Instagram open your phone's share sheet with {n > 1 ? current.label : 'this video'}. You pick the app and post from there; Kilo doesn't post for you.
      </Text>

      {video.postedAt ? (
        <Card padding={0} paddingHorizontal={16}>
          <PostedRow />
        </Card>
      ) : sharedTo ? (
        <Card gap={8}>
          <Text variant="body" weight={500}>
            Posted it on {sharedTo === 'tiktok' ? 'TikTok' : 'Instagram'}?
          </Text>
          <PillButton variant="secondary" surface="content" height={44} label="Yes, mark as posted" loading={posted.isPending} onPress={() => markPosted(sharedTo)} />
        </Card>
      ) : web ? (
        // Phones have Mark as posted under More; the web keeps it in reach here too.
        <PillButton variant="text" label="I posted this, mark as posted" onPress={() => markPosted('other')} loading={posted.isPending} />
      ) : null}
      {posted.isError ? (
        <Text variant="label" tone="cut">
          {errorMessage(posted.error)}
        </Text>
      ) : null}

      <VideoModal url={playing?.render?.url ?? null} title={`${video.title} · ${playing?.label ?? ''}`} onClose={() => setPlaying(null)} />
    </Screen>
  );
}

function PostedRow() {
  const c = useColors();
  return <Row minHeight={52} title="Marked as posted" subtitle="Counts toward this week's goal." right={<SymbolIcon name="check" strokeWidth={2.4} color={c.accent} />} />;
}

/**
 * The versions as a horizontal pager of 9:16 preview cards (180 wide, radius 20), centred and
 * snapping, with page dots under it. Tapping a card selects it and, once rendered, plays it.
 */
function Pager({
  versions,
  selected,
  onSelect,
  onPlay,
  thumbnailUrl,
  overlay,
}: {
  versions: Version[];
  selected: number;
  onSelect: (i: number) => void;
  onPlay: (v: Version) => void;
  thumbnailUrl: string | null;
  overlay: React.ReactNode;
}) {
  const s = useStyles();
  const { width } = useWindowDimensions();
  const scroller = useRef<ScrollViewInstance>(null);
  // The screen polls while rendering, signing the link afresh each time; keep the one that works.
  const thumb = useStableUrl(thumbnailUrl);
  const n = versions.length;
  const side = Math.max(space.gutter, (width - CARD_W) / 2);
  const step = CARD_W + CARD_GAP;
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const i = Math.min(n - 1, Math.max(0, Math.round(e.nativeEvent.contentOffset.x / step)));
    if (i !== selected) onSelect(i);
  };
  return (
    <View style={{ gap: 12 }}>
      <ScrollView
        ref={scroller}
        horizontal
        scrollEnabled={n > 1}
        showsHorizontalScrollIndicator={false}
        snapToInterval={step}
        decelerationRate="fast"
        disableIntervalMomentum
        onScroll={onScroll}
        scrollEventThrottle={32}
        style={s.pager}
        contentContainerStyle={{ paddingHorizontal: side, gap: CARD_GAP }}
      >
        {versions.map((x, i) => (
          <VersionCard
            key={x.variantId ?? 'base'}
            version={x}
            selected={i === selected}
            thumb={thumb.url}
            onThumbError={() => void thumb.renew()}
            overlay={i === selected ? overlay : null}
            onPress={() => {
              if (i !== selected) {
                onSelect(i);
                scroller.current?.scrollTo({ x: i * step, animated: true });
              }
              if (x.render?.status === 'done' && x.render.url) onPlay(x);
            }}
          />
        ))}
      </ScrollView>
      {n > 1 ? (
        <View style={s.dots} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {versions.map((x, i) => (
            <View key={x.variantId ?? 'base'} style={[s.dot, i === selected && s.dotOn]} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function VersionCard({
  version,
  selected,
  thumb,
  onThumbError,
  overlay,
  onPress,
}: {
  version: Version;
  selected: boolean;
  thumb: string | null;
  onThumbError: () => void;
  overlay: React.ReactNode;
  onPress: () => void;
}) {
  const s = useStyles();
  const c = useColors();
  const m = useLayoutMotion();
  const r = version.render;
  const done = r?.status === 'done';
  const failed = r?.status === 'failed';
  const state = versionState(version);
  return (
    <View style={{ width: CARD_W, gap: 8 }}>
      <PressableScale
        onPress={onPress}
        motion="card"
        accessibilityRole="button"
        accessibilityLabel={`${version.label}, ${formatDuration(version.durationSec)}. ${state}`}
        accessibilityState={{ selected }}
        style={s.card}
      >
        {thumb ? <Image source={{ uri: thumb }} onError={onThumbError} style={s.fill} contentFit="cover" accessibilityIgnoresInvertColors /> : null}
        {!done ? <View style={[s.fill, s.veil]} pointerEvents="none" /> : null}
        {/* The hook label: clear glass over the top of the video. */}
        <View style={s.labelSlot} pointerEvents="none">
          <Chip kind="glass" label={version.label} />
        </View>
        <View style={s.centre} pointerEvents="none">
          {overlay ? (
            <Animated.View exiting={native ? FadeOut.duration(200) : undefined}>{overlay}</Animated.View>
          ) : done ? (
            <Animated.View entering={m.appear}>
              <Glass kind="button" variant="clear" appearance="dark" radius={24} style={s.play}>
                <SymbolIcon name="play" size={18} color="#FFFFFF" />
              </Glass>
            </Animated.View>
          ) : failed ? (
            <View style={{ alignItems: 'center', gap: 6 }}>
              <SymbolIcon name="alert" filled size={28} color={c.cut} />
              <Text variant="label" weight={600} tone="cut">
                Export failed
              </Text>
            </View>
          ) : (
            <View style={{ alignItems: 'center', gap: 8 }}>
              <ProgressRing value={r?.progress ?? 0} size={44} accessibilityLabel={state} />
              <Text variant="label" weight={600} tabular>
                {state}
              </Text>
            </View>
          )}
        </View>
      </PressableScale>
      <Text variant="secondary" weight={selected ? 600 : 400} tone={selected ? 'ink' : 'muted'} numberOfLines={1} tabular>
        {version.label} · {formatDuration(version.durationSec)}
      </Text>
      {version.hookText ? (
        <Text variant="label" tone="muted" numberOfLines={2}>
          {`“${version.hookText}”`}
        </Text>
      ) : null}
      <Text variant="label" tone="muted" numberOfLines={1} testID={`version-overlays-${version.variantId ?? 'base'}`}>
        {version.overlays ?? 'No B-roll or graphics'}
      </Text>
    </View>
  );
}

function InfoRow({ label, value, divider }: { label: string; value: string; divider?: boolean }) {
  const s = useStyles();
  return (
    <View style={[s.info, divider && s.divider]}>
      <Text variant="body" tone="muted" style={{ fontSize: 14 }}>
        {label}
      </Text>
      <Text variant="body" weight={500} style={{ fontSize: 14, flexShrink: 1, textAlign: 'right' }}>
        {value}
      </Text>
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  two: { flexDirection: 'row', gap: 8 },
  flex: { flex: 1 },
  pager: { marginHorizontal: -space.gutter, flexGrow: 0 },
  card: { width: CARD_W, height: CARD_H, borderRadius: 20, borderCurve: 'continuous', overflow: 'hidden', backgroundColor: t.color.track, ...t.shadow.player },
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  // The first frame under a white veil while the version renders (brief 4.7).
  veil: { backgroundColor: t.scheme === 'dark' ? 'rgba(10,15,26,0.55)' : 'rgba(255,255,255,0.62)' },
  labelSlot: { position: 'absolute', top: 10, left: 0, right: 0, alignItems: 'center' },
  centre: { ...{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }, alignItems: 'center', justifyContent: 'center' },
  play: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: t.color.track },
  dotOn: { backgroundColor: t.color.accent, width: 16 },
  info: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 48, gap: 12 },
  divider: { borderTopWidth: 1, borderTopColor: t.color.hairline },
}));
