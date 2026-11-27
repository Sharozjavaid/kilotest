import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Platform, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { router, useLocalSearchParams } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import type { BrollAssetView, Edl, Overlay, VideoDetail } from '@kilo/edl';
import { getApi, getMockApi } from '@/api/client';
import { errorMessage } from '@/api/errors';
import { keys, useScreenFocused, useVideo } from '@/api/queries';
import { useEdlSaver } from '@/review/useEdlSaver';
import { getUploadQueue, useUploadJobs } from '@/uploads/UploadManager';
import { brollPoll } from '@/broll/polling';
import { pickFromLibrary, sampleFiles } from '@/newBatch/picker';
import type { PickedFile } from '@/newBatch/grouping';
import {
  assetTitle,
  overlayCardText,
  placeOverlay,
  placedCount,
  spokenLines,
  swapOverlay,
  type OverlayContent,
  type SpokenLine,
} from '@/broll/overlays';
import { OverlaySheet, assetStatus } from '@/broll/OverlaySheet';
import { versionsHiding } from '@/review/variantOverlays';
import { GraphicThumb } from '@/broll/GraphicThumb';
import { plural } from '@/lib/format';
import { FOOTER_BUTTON } from '@/components/sizes';
import {
  Card,
  EmptyState,
  ErrorState,
  LoadingBlock,
  PillButton,
  PressableScale,
  ProgressBar,
  Screen,
  SymbolIcon,
  Text,
  Thumb,
  makeStyles,
  radius,
  useColors,
  useLayoutMotion,
  type ScreenHeaderConfig,
} from '@/ui';

const native = Platform.OS !== 'web';
const swapFade = native ? FadeIn.duration(160) : undefined;

function confirmThen(title: string, message: string, onYes: () => void) {
  if (Platform.OS === 'web') {
    if ((globalThis as { confirm?: (m: string) => boolean }).confirm?.(`${title}\n\n${message}`) ?? true) onYes();
    return;
  }
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Redo', onPress: onYes },
  ]);
}

function notify(title: string, message: string) {
  if (Platform.OS === 'web') (globalThis as { alert?: (m: string) => void }).alert?.(`${title}\n\n${message}`);
  else Alert.alert(title, message);
}

const closeHeader = (meta?: string): ScreenHeaderConfig => ({ title: 'B-roll', meta, close: true });

/**
 * B-roll for one video (design brief 4.8; a page sheet over Review on iOS, so the creator lands
 * back on the same line). Param `id` is the video id.
 */
export default function BrollScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const video = useVideo(id);
  const v = video.data;
  const c = useColors();

  if (video.isPending) {
    return (
      <Screen appearance="auto" header={closeHeader()}>
        <LoadingBlock />
      </Screen>
    );
  }
  if (!v) {
    return (
      <Screen appearance="auto" header={closeHeader()}>
        <ErrorState error={video.error} onRetry={() => void video.refetch()} />
      </Screen>
    );
  }
  if (!v.edl) {
    return (
      <Screen appearance="auto" header={closeHeader()}>
        <Card gap={10} padding={24} style={{ alignItems: 'center' }}>
          <SymbolIcon name="sparkle" size={28} color={c.accent} />
          <Text variant="bodyLg" center>
            Kilo is still editing this video
          </Text>
          <Text variant="secondary" tone="muted" center>
            B-roll can be placed once the edit is ready.
          </Text>
          <View style={{ alignSelf: 'stretch' }}>
            <ProgressBar value={v.progress ?? 0} accessibilityLabel="Editing" />
          </View>
        </Card>
      </Screen>
    );
  }
  return <BrollBody video={v as VideoDetail & { edl: Edl }} refetch={() => void video.refetch()} />;
}

function BrollBody({ video, refetch }: { video: VideoDetail & { edl: Edl }; refetch: () => void }) {
  const st = useStyles();
  const m = useLayoutMotion();
  // Cards already there when the sheet opens just show; placements arriving later use `listInsert`.
  const opened = useRef(false);
  useEffect(() => {
    opened.current = true;
  }, []);
  const arrive = opened.current ? m.listInsert : undefined;
  const qc = useQueryClient();
  const { saver, state } = useEdlSaver(video.id, video.edl);
  const edl = state?.local ?? video.edl;
  const assets = video.broll;
  const lines = useMemo(() => spokenLines(edl), [edl]);
  const placed = useMemo(() => placedCount(edl), [edl]);
  const busy = video.status === 'analyzing' || video.status === 'queued';
  const canEdit = video.status === 'ready_for_review' || video.status === 'done';

  const jobs = useUploadJobs();
  const uploads = useMemo(() => {
    const m = new Map<string, number>();
    for (const j of jobs) if (j.kind === 'broll' && j.videoId === video.id && j.status !== 'done') m.set(j.id, j.sizeBytes ? j.bytesSent / j.sizeBytes : 0);
    return m;
  }, [jobs, video.id]);

  // Asset status (processing -> ready) is not a video status, so poll while any asset is on its way:
  // not forever, though. An upload that failed here, or a file not on this phone, cannot move; after a
  // few minutes with nothing changing the screen stops asking and offers a retry instead.
  const stateKey = assets.map((a) => `${a.id}:${a.status}`).join(',') + '|' + jobs.filter((j) => j.kind === 'broll').map((j) => `${j.id}:${j.status}`).join(',');
  const [since, setSince] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setSince(Date.now());
  }, [stateKey]);
  const poll = brollPoll(assets, jobs, since, now);
  // Only while this screen is in front.
  const focused = useScreenFocused();
  useEffect(() => {
    if (!poll.poll || !focused) return;
    const t = setInterval(() => {
      setNow(Date.now());
      refetch();
    }, 1500);
    return () => clearInterval(t);
  }, [poll.poll, focused, refetch]);
  const stuck = new Map(poll.stuck.map((x) => [x.id, x.canRetry]));
  const retryAsset = (id: string) => {
    setSince(Date.now());
    setNow(Date.now());
    getUploadQueue().retry([id]);
  };

  const [sheet, setSheet] = useState<{ line: SpokenLine; overlay: Overlay | null } | null>(null);
  const [adding, setAdding] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Clips that were waiting when the creator asked Kilo to place them. */
  const [askedToPlace, setAskedToPlace] = useState<string[]>([]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.video(video.id) });
    void qc.invalidateQueries({ queryKey: keys.home });
  };

  const apply = (content: OverlayContent, durationSec: number) => {
    if (!sheet || !saver) return { code: 'no_room' as const, message: 'Not ready yet.' };
    const r = sheet.overlay
      ? swapOverlay(edl, sheet.overlay.id, content, durationSec)
      : placeOverlay(edl, sheet.line.segment.id, content, { durationSec });
    if (!r.ok) return r.problem;
    saver.edit({ type: 'upsertOverlay', overlay: r.overlay });
    return null;
  };

  const remove = (overlay: Overlay) => {
    saver?.edit({ type: 'removeOverlay', overlayId: overlay.id });
    setSheet(null);
  };

  const addClips = async () => {
    setActionError(null);
    let files: PickedFile[];
    try {
      files = getMockApi() && Platform.OS === 'web' ? sampleFiles('media', 2) : await pickFromLibrary('media');
    } catch (e) {
      notify("Couldn't open your library", errorMessage(e));
      return;
    }
    if (!files.length) return;
    setAdding(true);
    try {
      const res = await getApi().addBroll(video.id, {
        assets: files.map((f) => ({ filename: f.filename, contentType: f.contentType, sizeBytes: f.sizeBytes, kind: f.kind })),
      });
      await getUploadQueue().enqueue(
        res.broll.map((b, i) => {
          const f = files[i]!;
          return { id: b.assetId, kind: 'broll' as const, videoId: video.id, batchId: video.batchId, fileUri: f.uri, filename: f.filename, contentType: f.contentType, sizeBytes: f.sizeBytes, target: b.upload };
        }),
      );
      refresh();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setAdding(false);
    }
  };

  const replan = async (pass: 'broll' | 'graphics') => {
    setActionError(null);
    try {
      await saver?.flush();
      if (pass === 'broll') setAskedToPlace(unplacedReady.map((a) => a.id));
      await getApi().replan(video.id, { passes: [pass] });
      refresh();
    } catch (e) {
      setActionError(errorMessage(e));
    }
  };

  const deleteAsset = async (a: BrollAssetView) => {
    setActionError(null);
    try {
      await saver?.flush();
      await getApi().deleteBroll(video.id, a.id);
      refresh();
    } catch (e) {
      setActionError(errorMessage(e));
    }
  };

  const done = async () => {
    await saver?.flush();
    if (router.canGoBack()) router.back();
    else router.replace(`/review/${video.id}`);
  };

  const moving = assets.filter((a) => a.status === 'uploading' || a.status === 'processing');
  const used = new Set(edl.overlays.flatMap((o) => (o.type === 'broll' ? [o.assetId] : [])));
  const unplacedReady = assets.filter((a) => a.status === 'ready' && !used.has(a.id));
  const themeId = edl.settings.graphicThemeId;

  return (
    <Screen
      appearance="auto"
      gap={14}
      header={{ ...closeHeader(`${plural(assets.length, 'clip')} added · ${placed} placed`), onBack: () => void done() }}
      footerGlass
      footer={
        <View style={st.actions}>
          <PillButton variant="secondary" surface="content" label="Add clips" height={FOOTER_BUTTON} style={{ flex: 1 }} onPress={addClips} loading={adding} disabled={!canEdit && !busy} testID="add-clips" />
          <PillButton label="Done" height={FOOTER_BUTTON} style={{ flex: 2 }} onPress={done} testID="broll-done" />
        </View>
      }
    >
      <Text variant="body" tone="muted">
        Placed against your script. Your voice keeps playing underneath. Swap or remove any of them.
      </Text>

      <SaveLine saving={!!state?.saving} error={state?.error} onRetry={() => void saver?.retry()} />

      {assets.length === 0 && edl.overlays.length === 0 && canEdit ? (
        <EmptyState icon="broll" title="No B-roll yet" body="Add your own clips. Kilo places them on the lines they fit." />
      ) : null}

      {moving.length ? (
        <Card gap={4} padding={0} paddingHorizontal={16} testID="adding-clips">
          <Text variant="body" weight={500} style={{ paddingTop: 14 }}>
            Adding {plural(moving.length, 'clip')}
          </Text>
          {moving.map((a, i) => (
            <AssetRow
              key={a.id}
              asset={a}
              divider={i > 0}
              upload={uploads.get(a.id)}
              stuck={stuck.has(a.id) ? { canRetry: !!stuck.get(a.id), onRetry: () => retryAsset(a.id) } : undefined}
              canRemove={stuck.has(a.id) && canEdit}
              onRemove={() => void deleteAsset(a)}
            />
          ))}
        </Card>
      ) : null}

      {busy ? (
        <Animated.View entering={m.listInsert} exiting={m.listRemove}>
          <Card gap={10} testID="replanning">
            <Text variant="body" weight={500}>
              Placing your clips…
            </Text>
            <ProgressBar value={video.progress ?? 0} accessibilityLabel="Placing" />
            <Text variant="label" tone="muted">
              Your cuts stay as they are. This page updates by itself.
            </Text>
          </Card>
        </Animated.View>
      ) : null}

      {/* While Kilo replans, the line cards wait at half opacity. */}
      <View style={[st.lines, busy && st.dim]} pointerEvents={busy ? 'none' : 'auto'}>
        {lines.map((line) =>
          line.overlays.length ? (
            line.overlays.map((o) => (
              <Animated.View key={o.id} entering={arrive} exiting={m.listRemove} layout={m.listLayout}>
                <LineCard
                  line={line}
                  overlay={o}
                  assets={assets}
                  themeId={themeId}
                  hiddenIn={versionsHiding(edl, o.id)}
                  disabled={!canEdit}
                  onSwap={() => setSheet({ line, overlay: o })}
                  onRemove={() => remove(o)}
                />
              </Animated.View>
            ))
          ) : (
            <Animated.View key={line.segment.id} entering={arrive} exiting={m.listRemove} layout={m.listLayout}>
              <EmptyLineCard line={line} disabled={!canEdit} onAdd={() => setSheet({ line, overlay: null })} />
            </Animated.View>
          ),
        )}
      </View>

      {actionError ? (
        <Text variant="secondary" tone="cut" testID="broll-error">
          {actionError}
        </Text>
      ) : null}

      {!busy && askedToPlace.some((id) => unplacedReady.some((a) => a.id === id)) ? (
        <Text variant="secondary" tone="muted" testID="not-placed-note">
          Kilo found no free line for {plural(askedToPlace.filter((id) => unplacedReady.some((a) => a.id === id)).length, 'clip')}: the video already has as much on screen as it can carry. Tap Add on a line, or swap an overlay, to use it.
        </Text>
      ) : null}

      {unplacedReady.length > 0 && canEdit ? (
        <Card gap={10} testID="place-for-me">
          <Text variant="body" weight={500}>
            {plural(unplacedReady.length, 'clip')} not placed yet
          </Text>
          <Text variant="secondary" tone="muted">
            Kilo can find the right lines for them. Your cuts and the overlays you chose stay.
          </Text>
          <PillButton label="Place them for me" height={52} icon="sparkle" onPress={() => void replan('broll')} testID="place-them" />
        </Card>
      ) : null}

      {assets.length > 0 ? (
        <View style={{ gap: 6 }}>
          <Text variant="secondary" weight={600} tone="muted" accessibilityRole="header">
            Your clips
          </Text>
          <Card padding={0} paddingHorizontal={16}>
            {assets.map((a, i) => (
              <Animated.View key={a.id} entering={arrive} exiting={m.listRemove} layout={m.listLayout}>
                <AssetRow asset={a} divider={i > 0} upload={uploads.get(a.id)} canRemove={canEdit} onRemove={() => void deleteAsset(a)} />
              </Animated.View>
            ))}
          </Card>
        </View>
      ) : null}

      {canEdit ? <PillButton
          variant="text"
          icon="refresh"
          label="Redo graphics"
          onPress={() => confirmThen('Redo graphics?', 'Kilo picks new motion graphics for this video. The graphics on it now are replaced; your clips and cuts stay.', () => void replan('graphics'))}
          testID="redo-graphics"
        /> : null}

      <OverlaySheet
        visible={!!sheet}
        line={sheet?.line ?? null}
        overlay={sheet?.overlay ?? null}
        assets={assets}
        themeId={themeId}
        uploads={uploads}
        onApply={apply}
        onRemove={() => sheet?.overlay && remove(sheet.overlay)}
        versions={
          sheet?.overlay && edl.overlays.some((o) => o.id === sheet.overlay!.id)
            ? edl.variants.map((x) => ({ id: x.id, label: x.label, hidden: x.hiddenOverlayIds.includes(sheet.overlay!.id) }))
            : []
        }
        onSetHidden={(variantId, hidden) => sheet?.overlay && saver?.edit({ type: 'overlayHidden', variantId, overlayId: sheet.overlay.id, hidden })}
        onAddClips={() => {
          setSheet(null);
          void addClips();
        }}
        onClose={() => setSheet(null)}
      />
    </Screen>
  );
}

function SaveLine({ saving, error, onRetry }: { saving: boolean; error: unknown; onRetry: () => void }) {
  if (error) {
    return (
      <PressableScale onPress={onRetry} motion="row" accessibilityRole="button" accessibilityLabel="Couldn't save. Tap to try again" testID="broll-save-error">
        <Text variant="secondary" tone="cut">
          Couldn't save: {errorMessage(error)} Tap to retry.
        </Text>
      </PressableScale>
    );
  }
  if (!saving) return null;
  return (
    <Text variant="secondary" tone="muted" testID="broll-saving">
      Saving…
    </Text>
  );
}

function LineCard({
  line,
  overlay,
  assets,
  themeId,
  hiddenIn,
  disabled,
  onSwap,
  onRemove,
}: {
  line: SpokenLine;
  overlay: Overlay;
  assets: readonly BrollAssetView[];
  themeId: string;
  /** Labels of the openings that leave this overlay out. */
  hiddenIn: string[];
  disabled: boolean;
  onSwap: () => void;
  onRemove: () => void;
}) {
  const s = useStyles();
  const t = overlayCardText(overlay, assets);
  const asset = overlay.type === 'broll' ? assets.find((a) => a.id === overlay.assetId) : undefined;
  // Swapping cross-fades the thumb (160 ms): it is keyed by what it shows.
  const contentKey = overlay.type === 'broll' ? `a:${overlay.assetId}` : `g:${overlay.template}`;
  return (
    <Card padding={14} gap={12} testID={`line-${line.segment.id}`}>
      <Text variant="body" style={s.quote}>
        “{line.segment.text}”
      </Text>
      <View style={s.row}>
        <Animated.View key={contentKey} entering={swapFade}>
          {overlay.type === 'graphic' ? (
            <GraphicThumb template={overlay.template} props={overlay.props} themeId={themeId} width={44} height={78} />
          ) : (
            <Thumb uri={asset?.thumbnailUrl} cacheKey={asset?.id} width={44} height={78} r={8} />
          )}
        </Animated.View>
        <View style={s.text}>
          <Text variant="label" weight={600} tone="accent">
            {t.kind}
          </Text>
          <Text variant="secondary" weight={500} numberOfLines={2}>
            {t.title}
          </Text>
          <Text variant="label" tone="muted" numberOfLines={2}>
            {t.detail}
          </Text>
          {hiddenIn.length ? (
            <Text variant="label" tone="muted" numberOfLines={1} testID={`hidden-in-${overlay.id}`}>
              Not in {hiddenIn.join(', ')}
            </Text>
          ) : null}
        </View>
      </View>
      <View style={s.buttons}>
        <PillButton variant="secondary" surface="content" label="Swap" height={44} onPress={onSwap} disabled={disabled} style={s.flex} accessibilityLabel={`Swap ${t.title}`} testID={`swap-${overlay.id}`} />
        <PillButton variant="secondary" surface="content" destructive label="Remove" height={44} onPress={onRemove} disabled={disabled} style={s.flex} accessibilityLabel={`Remove ${t.title} from this line`} testID={`remove-${overlay.id}`} />
      </View>
    </Card>
  );
}

function EmptyLineCard({ line, disabled, onAdd }: { line: SpokenLine; disabled: boolean; onAdd: () => void }) {
  const s = useStyles();
  return (
    <View style={s.empty} testID={`line-${line.segment.id}`}>
      <Text variant="body" tone="muted" style={[s.quote, { flex: 1 }]}>
        “{line.segment.text}”
      </Text>
      <PillButton variant="secondary" surface="content" label="Add" icon="plus" height={44} onPress={onAdd} disabled={disabled} style={s.add} accessibilityLabel={`Add B-roll or a graphic to “${line.segment.text}”`} testID={`add-${line.segment.id}`} />
    </View>
  );
}

function AssetRow({
  asset,
  divider,
  upload,
  canRemove,
  onRemove,
  stuck,
}: {
  asset: BrollAssetView;
  divider: boolean;
  upload?: number;
  canRemove: boolean;
  onRemove: () => void;
  stuck?: { canRetry: boolean; onRetry: () => void };
}) {
  const s = useStyles();
  const c = useColors();
  const status = stuck ? (stuck.canRetry ? 'Upload stopped' : 'Not uploaded from this phone') : assetStatus(asset, upload);
  return (
    <View style={[s.assetRow, divider && s.divider]} testID={`bin-${asset.id}`}>
      <Thumb uri={asset.status === 'ready' ? asset.thumbnailUrl : null} cacheKey={asset.id} width={36} height={48} />
      <View style={{ flex: 1, gap: 4 }}>
        <Text variant="secondary" weight={500} numberOfLines={1}>
          {assetTitle(asset)}
        </Text>
        <Text variant="label" tone={asset.status === 'failed' ? 'cut' : 'muted'} tabular>
          {status}
        </Text>
        {asset.status === 'uploading' && upload !== undefined && !stuck ? <ProgressBar value={upload} height={3} accessibilityLabel={`${asset.filename} ${status}`} /> : null}
      </View>
      {stuck?.canRetry ? (
        <PillButton variant="secondary" surface="content" height={44} label="Retry" onPress={stuck.onRetry} accessibilityLabel={`Retry uploading ${assetTitle(asset)}`} testID={`retry-${asset.id}`} />
      ) : null}
      {canRemove ? (
        <PressableScale onPress={onRemove} motion="icon" accessibilityRole="button" accessibilityLabel={`Delete ${assetTitle(asset)}`} style={s.iconHit} testID={`delete-${asset.id}`}>
          <SymbolIcon name="trash" size={17} color={c.muted} />
        </PressableScale>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  actions: { flexDirection: 'row', gap: 8 },
  lines: { gap: 14 },
  dim: { opacity: 0.5 },
  quote: { lineHeight: 21 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  text: { flex: 1, gap: 3 },
  buttons: { flexDirection: 'row', gap: 8 },
  flex: { flex: 1 },
  add: { flexShrink: 0, paddingHorizontal: 16 },
  empty: {
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: t.color.dropBorder,
    backgroundColor: t.color.dropFill,
    borderRadius: radius.card,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  assetRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, paddingVertical: 8 },
  divider: { borderTopWidth: 1, borderTopColor: t.color.hairline },
  iconHit: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
}));
