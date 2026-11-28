import { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { VideoView } from 'expo-video';
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useQueryClient } from '@tanstack/react-query';
import { diffEdl, mapTime, playbackRanges, type EdlVersionResponse, type ListEdlVersionsResponse, type VideoDetail } from '@kilo/edl';
import { keys, useEdlVersion, useEdlVersions, useRestoreEdl, useVideo } from '@/api/queries';
import { errorMessage, isKiloApiError } from '@/api/errors';
import { formatDuration } from '@/lib/format';
import { useStableUrl } from '@/lib/stableUrl';
import { useSkipPlayer } from '@/review/useSkipPlayer';
import { useCompareSync } from '@/review/useCompareSync';
import { CompareScrub } from '@/review/CompareScrub';
import { authorLabel, changeRows, compareLayout, comparePair, restoreTarget, scrubMarks, variantIn, type ChangeRow, type CompareLayout } from '@/review/versions';
import {
  ActionMenu,
  Card,
  Chip,
  ErrorState,
  Glass,
  PillButton,
  PressableScale,
  Screen,
  Skeleton,
  SymbolIcon,
  Text,
  haptic,
  makeStyles,
  motionHaptics,
  space,
  timings,
  toast,
  useColors,
  useLayoutMotion,
  useReducedMotionSetting,
  type MenuItem,
  type ScreenHeaderConfig,
} from '@/ui';
import { FOOTER_BUTTON } from '@/components/sizes';

const native = Platform.OS !== 'web';

const header = (meta?: string): ScreenHeaderConfig => ({ title: 'Compare', meta, close: true, size: 'titleSm' });

type ReadyVideo = VideoDetail & { proxy: NonNullable<VideoDetail['proxy']> };

/**
 * Two versions of one edit in step (a page sheet over Versions on iOS; pushed elsewhere). Params:
 * `id` the video, `rev` the version tapped (the one Restore brings back), `vs` the one to compare
 * it with (the current edit by default), `variant` the opening Review was showing.
 *
 * Both play the same review proxy, each skipping its own cuts (no render). The newer leads; the
 * older follows through `mapTime`. Under them, what changed (`diffEdl(older, newer)`).
 */
export default function CompareScreen() {
  const params = useLocalSearchParams<{ id: string; rev?: string; vs?: string; variant?: string }>();
  const id = params.id;
  const versions = useEdlVersions(id);
  const video = useVideo(id);
  const current = versions.data?.current;
  const rev = num(params.rev) ?? current;
  // The second version: picked here, else the one in the link, else the current edit.
  const [picked, setPicked] = useState<number | null>(null);
  const vs = picked ?? num(params.vs) ?? current;
  const a = useEdlVersion(id, rev);
  const b = useEdlVersion(id, vs);

  const error = versions.error ?? video.error ?? a.error ?? b.error;
  if (error && !(versions.data && video.data && a.data && b.data)) {
    return (
      <Screen appearance="auto" header={header()}>
        <ErrorState
          error={error}
          onRetry={() => {
            void versions.refetch();
            void video.refetch();
            void a.refetch();
            void b.refetch();
          }}
        />
      </Screen>
    );
  }
  const v = video.data;
  if (!versions.data || !v || !a.data || !b.data || rev == null || vs == null) return <CompareSkeleton />;
  if (!v.proxy) {
    return (
      <Screen appearance="auto" header={header()}>
        <Card>
          <Text variant="body">This video is being edited again. Compare its versions once it is ready.</Text>
        </Card>
      </Screen>
    );
  }
  const pair = comparePair(rev, vs);
  const older = pair.older === a.data.version.revision ? a.data : b.data;
  const newer = pair.newer === b.data.version.revision ? b.data : a.data;
  return (
    <CompareBody
      // A new pair is a new comparison: fresh players and sync.
      key={`${older.version.revision}-${newer.version.revision}`}
      video={v as ReadyVideo}
      list={versions.data}
      older={older}
      newer={newer}
      rev={rev}
      vs={vs}
      variant={params.variant ?? null}
      onPick={setPicked}
      onReload={() => {
        void versions.refetch();
        void video.refetch();
      }}
    />
  );
}

function num(x: string | undefined): number | undefined {
  if (x == null || x === '') return undefined;
  const n = Number(x);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function CompareSkeleton() {
  const { width, height } = useWindowDimensions();
  const l = compareLayout(width, height);
  return (
    <Screen appearance="auto" scroll={false} header={header()}>
      <View style={{ gap: 12 }} accessibilityLabel="Loading" accessibilityRole="progressbar">
        <View style={{ flexDirection: 'row', gap: 14 }}>
          <Skeleton width={l.older.width} height={l.older.height} radius={12} />
          <View style={{ flex: 1, gap: 8, paddingTop: 4 }}>
            <Skeleton width="30%" height={16} />
            <Skeleton width="60%" height={12} />
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: 14 }}>
          <Skeleton width={l.newer.width} height={l.newer.height} radius={16} />
          <View style={{ flex: 1, gap: 8, paddingTop: 4 }}>
            <Skeleton width="30%" height={16} />
            <Skeleton width="60%" height={12} />
          </View>
        </View>
        <Skeleton height={36} radius={8} />
        <Skeleton height={44} radius={14} />
        <Skeleton height={44} radius={14} />
      </View>
    </Screen>
  );
}

// ---- The comparison ----------------------------------------------------------------------------

const useStyles = makeStyles((t) => ({
  players: { gap: 12 },
  playersSide: { flexDirection: 'row', gap: 16, justifyContent: 'center' },
  panel: { flexDirection: 'row', gap: 14, alignItems: 'flex-start' },
  panelSide: { flex: 1, gap: 8, alignItems: 'center', maxWidth: 280 },
  info: { flex: 1, gap: 2, paddingTop: 2 },
  infoSide: { alignItems: 'center', gap: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  player: { backgroundColor: t.color.player, overflow: 'hidden', borderCurve: 'continuous', ...t.shadow.player },
  video: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' },
  playHit: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  playButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  hint: { position: 'absolute', left: 6, right: 6, bottom: 6, height: 22, borderRadius: 11, backgroundColor: t.scheme === 'dark' ? 'rgba(240,135,90,0.9)' : 'rgba(180,68,30,0.9)', alignItems: 'center', justifyContent: 'center' },
  transport: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  playCtl: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: t.color.fill, borderWidth: 1, borderColor: t.color.outline },
  scrub: { flex: 1 },
  list: { flex: 1, minHeight: 0, marginHorizontal: -space.gutter },
  listContent: { paddingHorizontal: space.gutter, gap: 8, paddingBottom: 12 },
  change: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, paddingVertical: 10, paddingHorizontal: 14, borderRadius: 14, borderCurve: 'continuous', backgroundColor: t.color.surface, borderWidth: 1, borderColor: t.color.hairline },
  changeIcon: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: t.color.chipOn },
  changeText: { flex: 1 },
}));

function CompareBody({
  video,
  list,
  older,
  newer,
  rev,
  vs,
  variant,
  onPick,
  onReload,
}: {
  video: ReadyVideo;
  list: ListEdlVersionsResponse;
  older: EdlVersionResponse;
  newer: EdlVersionResponse;
  rev: number;
  vs: number;
  variant: string | null;
  onPick: (revision: number) => void;
  onReload: () => void;
}) {
  const s = useStyles();
  const c = useColors();
  const qc = useQueryClient();
  const { width, height } = useWindowDimensions();
  const layout = compareLayout(width, height);
  const offsets = video.proxy.clipOffsets;
  const oldEdl = older.edl;
  const newEdl = newer.edl;

  // The opening Review was showing, where each version has it; else the newer's first, else the base cut.
  const variantId = variantIn(newEdl, variant) ?? newEdl.variants[0]?.id ?? null;
  const vOld = variantIn(oldEdl, variantId);
  const vNew = variantIn(newEdl, variantId);
  const rOld = useMemo(() => playbackRanges(oldEdl, offsets, vOld), [oldEdl, offsets, vOld]);
  const rNew = useMemo(() => playbackRanges(newEdl, offsets, vNew), [newEdl, offsets, vNew]);
  const durOld = rOld.at(-1)?.outEnd ?? 0;
  const durNew = rNew.at(-1)?.outEnd ?? 0;
  const changes = useMemo(() => diffEdl(oldEdl, newEdl, variantId), [oldEdl, newEdl, variantId]);
  const rows = useMemo(() => changeRows(changes), [changes]);
  const { marks, spans } = useMemo(() => scrubMarks(changes, durNew), [changes, durNew]);
  const cutMoments = useMemo(() => rows.flatMap((r) => (r.cutAt != null ? [r.cutAt] : [])), [rows]);

  const proxyUrl = useStableUrl(video.proxy.url);
  const refetchVideo = useVideo(video.id).refetch;
  const onError = () => {
    if (!proxyUrl.renew()) void refetchVideo().then(() => proxyUrl.renew());
  };
  const lead = useSkipPlayer(proxyUrl.url, rNew, { onError });
  const follow = useSkipPlayer(proxyUrl.url, rOld, { onError });
  const map = useMemo(() => (t: number) => mapTime(newEdl, oldEdl, t, variantId), [newEdl, oldEdl, variantId]);
  const sync = useCompareSync(lead, follow, map, cutMoments);

  // ---- restore ----
  const target = restoreTarget(rev, vs, list.current);
  const restore = useRestoreEdl(video.id);
  const onRestore = () => {
    if (target == null) return;
    sync.pause();
    restore.mutate(
      { revision: target, baseRevision: list.current },
      {
        onSuccess: (res) => {
          toast.success(`Restored v${target} as v${res.edl.revision}`);
          router.dismissTo(`/review/${video.id}`);
        },
        onError: (e) => {
          if (isKiloApiError(e) && e.isConflict) {
            // Someone (another device, a replan) saved meanwhile: show the latest before restoring over it.
            onReload();
            void qc.invalidateQueries({ queryKey: keys.edlVersions(video.id) });
            toast.error('The edit changed while you were comparing. Check the latest version, then restore again.');
          } else toast.error(errorMessage(e));
        },
      },
    );
  };

  // ---- the second version ----
  const pickItems = useMemo<MenuItem[]>(
    () =>
      [...list.versions]
        .sort((x, y) => y.revision - x.revision)
        .filter((x) => x.revision !== rev)
        .map((x) => ({
          label: `v${x.revision}${x.revision === list.current ? ' (current)' : ''}`,
          subtitle: `${authorLabel(x)} · ${x.summary}`,
          icon: x.revision === vs ? 'check' : undefined,
          onPress: () => {
            haptic(motionHaptics.select);
            onPick(x.revision);
          },
          testID: `compare-pick-${x.revision}`,
        })),
    [list, rev, vs, onPick],
  );

  const panel = (which: 'older' | 'newer') => {
    const v = which === 'older' ? older : newer;
    const sp = which === 'older' ? follow : lead;
    const size = which === 'older' ? layout.older : layout.newer;
    const isPick = v.version.revision === vs && v.version.revision !== rev;
    return (
      <PlayerPanel
        key={which}
        testID={`compare-${which}`}
        layout={layout}
        size={size}
        radius={which === 'older' && layout.mode === 'stack' ? 12 : 16}
        title={`v${v.version.revision}`}
        current={v.version.revision === list.current}
        who={authorLabel(v.version)}
        duration={formatDuration(which === 'older' ? durOld : durNew)}
        player={sp.player}
        playing={sync.playing}
        onToggle={sync.toggle}
        hint={sync.hints[which]}
        picker={isPick && pickItems.length > 1 ? pickItems : undefined}
      />
    );
  };

  const restoreLabel = target == null ? 'This is the current edit' : `Restore v${target}`;
  const variantLabel = vNew ? newEdl.variants.find((x) => x.id === vNew)?.label : undefined;

  return (
    <Screen
      appearance="auto"
      scroll={false}
      gap={12}
      contentStyle={{ paddingBottom: 0 }}
      header={header(variantLabel)}
      footerGlass
      footer={
        <PillButton
          variant="primary"
          height={FOOTER_BUTTON}
          icon="restore"
          label={restoreLabel}
          disabled={target == null}
          loading={restore.isPending}
          onPress={onRestore}
          accessibilityHint={target == null ? undefined : `Brings back v${target} as a new version. Nothing is lost.`}
          testID="restore-version"
        />
      }
    >
      <View style={layout.mode === 'side' ? s.playersSide : s.players}>
        {panel('older')}
        {panel('newer')}
      </View>

      <View style={s.transport}>
        <PressableScale
          onPress={sync.toggle}
          motion="icon"
          accessibilityRole="button"
          accessibilityLabel={sync.playing ? 'Pause both' : 'Play both'}
          testID="compare-play"
          style={s.playCtl}
        >
          <SymbolIcon name={sync.playing ? 'pause' : 'play'} size={18} color={c.ink} />
        </PressableScale>
        <View style={s.scrub}>
          <CompareScrub duration={durNew} time={lead.outputTime} marks={marks} spans={spans} onScrub={sync.scrub} onScrubEnd={sync.scrubEnd} />
        </View>
      </View>

      <View style={s.list}>
        <ScrollView contentContainerStyle={s.listContent} testID="change-list">
          <Text variant="secondary" weight={600} tone="muted" accessibilityRole="header">
            {rows.length ? `What changed from v${older.version.revision} to v${newer.version.revision}` : `No visible change from v${older.version.revision} to v${newer.version.revision}`}
          </Text>
          {rows.map((r, i) => (
            <ChangeRowView key={r.key} row={r} index={i} onPress={() => {
              haptic(motionHaptics.select);
              sync.seek(r.seekTo, { cut: r.cutAt != null });
            }} />
          ))}
        </ScrollView>
      </View>
    </Screen>
  );
}

// ---- Parts ------------------------------------------------------------------------------------------

function PlayerPanel({
  layout,
  size,
  radius,
  title,
  current,
  who,
  duration,
  player,
  playing,
  onToggle,
  hint,
  picker,
  testID,
}: {
  layout: CompareLayout;
  size: { width: number; height: number };
  radius: number;
  title: string;
  current: boolean;
  who: string;
  duration: string;
  player: ReturnType<typeof useSkipPlayer>['player'];
  playing: boolean;
  onToggle: () => void;
  hint: boolean;
  picker?: MenuItem[];
  testID: string;
}) {
  const s = useStyles();
  const side = layout.mode === 'side';
  return (
    <View style={side ? s.panelSide : s.panel} testID={testID}>
      <View style={[s.player, { width: size.width, height: size.height, borderRadius: radius }]}>
        <VideoView player={player} style={s.video} contentFit="cover" nativeControls={false} />
        <Pressable onPress={onToggle} accessibilityRole="button" accessibilityLabel={`${playing ? 'Pause' : 'Play'} ${title}`} style={s.playHit} testID={`${testID}-player`}>
          {/* Over video, glass is small and only while paused (brief 1.5). */}
          {!playing ? (
            <Glass kind="button" variant="clear" appearance="dark" radius={20} style={s.playButton}>
              <View style={{ marginLeft: 2 }}>
                <SymbolIcon name="play" size={16} color="#FFFFFF" />
              </View>
            </Glass>
          ) : null}
        </Pressable>
        <CutHint visible={hint} testID={`${testID}-cut-hint`} />
      </View>
      <View style={side ? s.infoSide : s.info}>
        <View style={s.titleRow}>
          <Text variant="bodyLg" weight={600} tabular>
            {title}
          </Text>
          {current ? <Chip kind="status" label="Current" /> : null}
          {picker ? <ActionMenu icon="chevronDown" label="Compare with another version" title="Compare with" items={picker} testID="compare-pick" /> : null}
        </View>
        <Text variant="secondary" tone="muted" numberOfLines={1}>
          {who}
        </Text>
        <Text variant="secondary" tone="muted" tabular>
          {duration}
        </Text>
      </View>
    </View>
  );
}

/** "Cut here" on a player whose version lost the footage at this moment. Fades in and out (150 ms). */
function CutHint({ visible, testID }: { visible: boolean; testID: string }) {
  const s = useStyles();
  const reduced = useReducedMotionSetting();
  const o = useSharedValue(visible ? 1 : 0);
  const [mounted, setMounted] = useState(visible);
  useEffect(() => {
    if (visible) setMounted(true);
    if (!native) {
      if (!visible) setMounted(false);
      return;
    }
    o.value = withTiming(visible ? 1 : 0, { duration: reduced ? 0 : timings.reducedFade.duration, reduceMotion: ReduceMotion.Never });
    if (!visible) {
      const t = setTimeout(() => setMounted(false), timings.reducedFade.duration);
      return () => clearTimeout(t);
    }
  }, [visible, o, reduced]);
  const style = useAnimatedStyle(() => ({ opacity: o.value }));
  if (!mounted) return null;
  return (
    <Animated.View style={[s.hint, native ? style : null]} pointerEvents="none" testID={testID} accessibilityLiveRegion="polite">
      <Text variant="label" weight={600} tone="white">
        Cut here
      </Text>
    </Animated.View>
  );
}

function ChangeRowView({ row, index, onPress }: { row: ChangeRow; index: number; onPress: () => void }) {
  const s = useStyles();
  const c = useColors();
  const m = useLayoutMotion();
  const tone = row.tone === 'cut' ? c.cut : row.tone === 'accent' ? c.accent : c.ink;
  return (
    <Animated.View entering={m.appearAt(index)}>
      <PressableScale
        onPress={onPress}
        motion="row"
        pressedBackgroundColor={c.pressedRow}
        accessibilityRole="button"
        accessibilityLabel={row.label}
        accessibilityHint="Plays both versions from here"
        testID={`change-${row.kind}`}
        style={s.change}
      >
        <View style={s.changeIcon}>
          <SymbolIcon name={row.icon} size={15} color={tone} />
        </View>
        <Text variant="secondary" style={s.changeText} numberOfLines={2}>
          {row.text}
        </Text>
        <Text variant="label" tone="muted" tabular>
          {row.time}
        </Text>
      </PressableScale>
    </Animated.View>
  );
}
