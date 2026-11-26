import { useEffect, useMemo, useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import type { BrollAssetView, Edl, Overlay, VideoDetail } from '@kilo/edl';
import { getApi, getMockApi } from '@/api/client';
import { errorMessage } from '@/api/errors';
import { keys, useVideo } from '@/api/queries';
import { useEdlSaver } from '@/review/useEdlSaver';
import { getUploadQueue, useUploadJobs } from '@/uploads/UploadManager';
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
import { GraphicThumb } from '@/broll/GraphicThumb';
import { plural } from '@/lib/format';
import {
  Card,
  ErrorState,
  Header,
  Icon,
  LoadingBlock,
  PillButton,
  ProgressBar,
  Screen,
  SectionLabel,
  Text,
  Thumb,
  color,
  radius,
} from '@/ui';

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

/** B-roll for one video (mock-up `Broll`). Param `id` is the video id. */
export default function BrollScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const video = useVideo(id);
  const v = video.data;

  if (video.isPending) {
    return (
      <Screen>
        <Header title="B-roll" />
        <LoadingBlock />
      </Screen>
    );
  }
  if (!v) {
    return (
      <Screen>
        <Header title="B-roll" />
        <ErrorState error={video.error} onRetry={() => void video.refetch()} />
      </Screen>
    );
  }
  if (!v.edl) {
    return (
      <Screen>
        <Header title="B-roll" />
        <Card gap={10} padding={24} style={{ alignItems: 'center' }}>
          <Icon name="sparkle" size={28} color={color.accent} />
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

  // Asset status (processing -> ready) is not a video status, so poll while any asset is on its way.
  const assetsMoving = assets.some((a) => a.status === 'uploading' || a.status === 'processing');
  useEffect(() => {
    if (!assetsMoving) return;
    const t = setInterval(refetch, 1500);
    return () => clearInterval(t);
  }, [assetsMoving, refetch]);

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
      gap={14}
      footer={
        <View style={styles.actions}>
          <PillButton variant="secondary" label="Add clips" style={{ flex: 1 }} onPress={addClips} loading={adding} disabled={!canEdit && !busy} testID="add-clips" />
          <PillButton label="Done" height={52} style={{ flex: 2 }} onPress={done} testID="broll-done" />
        </View>
      }
    >
      <Header title="B-roll" meta={`${plural(assets.length, 'clip')} added · ${placed} placed`} />
      <Text variant="transcript" tone="muted" style={{ lineHeight: 20 }}>
        Placed against your script. Your voice keeps playing underneath. Swap or remove any of them.
      </Text>

      <SaveLine saving={!!state?.saving} error={state?.error} onRetry={() => void saver?.retry()} />

      {moving.length ? (
        <Card gap={4} padding={0} paddingHorizontal={16} testID="adding-clips">
          <Text variant="body" weight={500} style={{ paddingTop: 14 }}>
            Adding {plural(moving.length, 'clip')}
          </Text>
          {moving.map((a, i) => (
            <AssetRow key={a.id} asset={a} divider={i > 0} upload={uploads.get(a.id)} canRemove={false} onRemove={() => undefined} />
          ))}
        </Card>
      ) : null}

      {busy ? (
        <Card gap={10} testID="replanning">
          <Text variant="body" weight={500}>
            Placing your clips and graphics…
          </Text>
          <ProgressBar value={video.progress ?? 0} accessibilityLabel="Placing" />
          <Text variant="label" tone="muted">
            Your cuts stay as they are. This page updates by itself.
          </Text>
        </Card>
      ) : null}

      {lines.map((line) =>
        line.overlays.length ? (
          line.overlays.map((o) => (
            <LineCard key={o.id} line={line} overlay={o} assets={assets} themeId={themeId} disabled={!canEdit} onSwap={() => setSheet({ line, overlay: o })} onRemove={() => remove(o)} />
          ))
        ) : (
          <EmptyLineCard key={line.segment.id} line={line} disabled={!canEdit} onAdd={() => setSheet({ line, overlay: null })} />
        ),
      )}

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
          <SectionLabel>Your clips</SectionLabel>
          <Card padding={0} paddingHorizontal={16}>
            {assets.map((a, i) => (
              <AssetRow key={a.id} asset={a} divider={i > 0} upload={uploads.get(a.id)} canRemove={canEdit} onRemove={() => void deleteAsset(a)} />
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
      <Pressable onPress={onRetry} accessibilityRole="button" accessibilityLabel="Couldn't save. Tap to try again" testID="broll-save-error">
        <Text variant="secondary" tone="cut">
          Couldn't save: {errorMessage(error)} Tap to retry.
        </Text>
      </Pressable>
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
  disabled,
  onSwap,
  onRemove,
}: {
  line: SpokenLine;
  overlay: Overlay;
  assets: readonly BrollAssetView[];
  themeId: string;
  disabled: boolean;
  onSwap: () => void;
  onRemove: () => void;
}) {
  const t = overlayCardText(overlay, assets);
  const asset = overlay.type === 'broll' ? assets.find((a) => a.id === overlay.assetId) : undefined;
  return (
    <Card padding={14} gap={12} testID={`line-${line.segment.id}`}>
      <View style={styles.quoteRow}>
        <Text variant="body" style={styles.quote}>
          “{line.segment.text}”
        </Text>
        <Pressable onPress={onRemove} disabled={disabled} accessibilityRole="button" accessibilityLabel={`Remove ${t.title} from this line`} hitSlop={6} style={[styles.remove, disabled && { opacity: 0.4 }]} testID={`remove-${overlay.id}`}>
          <Icon name="close" size={16} color={color.muted} />
        </Pressable>
      </View>
      <View style={styles.row}>
        {overlay.type === 'graphic' ? (
          <GraphicThumb template={overlay.template} props={overlay.props} themeId={themeId} />
        ) : (
          <Thumb uri={asset?.thumbnailUrl} width={54} height={72} r={10} />
        )}
        <View style={styles.text}>
          <Text variant="label" weight={600} tone="accent">
            {t.kind}
          </Text>
          <Text variant="transcript" weight={500} numberOfLines={2}>
            {t.title}
          </Text>
          <Text variant="label" tone="muted" numberOfLines={2}>
            {t.detail}
          </Text>
        </View>
        <PillButton variant="secondary" label="Swap" height={44} onPress={onSwap} disabled={disabled} style={styles.swap} accessibilityLabel={`Swap ${t.title}`} testID={`swap-${overlay.id}`} />
      </View>
    </Card>
  );
}

function EmptyLineCard({ line, disabled, onAdd }: { line: SpokenLine; disabled: boolean; onAdd: () => void }) {
  return (
    <View style={styles.empty} testID={`line-${line.segment.id}`}>
      <Text variant="body" tone="muted" style={[styles.quote, { flex: 1 }]}>
        “{line.segment.text}”
      </Text>
      <PillButton variant="secondary" label="Add" height={44} onPress={onAdd} disabled={disabled} style={styles.add} accessibilityLabel={`Add B-roll or a graphic to “${line.segment.text}”`} testID={`add-${line.segment.id}`} />
    </View>
  );
}

function AssetRow({ asset, divider, upload, canRemove, onRemove }: { asset: BrollAssetView; divider: boolean; upload?: number; canRemove: boolean; onRemove: () => void }) {
  const status = assetStatus(asset, upload);
  return (
    <View style={[styles.assetRow, divider && styles.divider]} testID={`bin-${asset.id}`}>
      <Thumb uri={asset.status === 'ready' ? asset.thumbnailUrl : null} width={36} height={48} />
      <View style={{ flex: 1, gap: 4 }}>
        <Text variant="secondary" weight={500} numberOfLines={1}>
          {assetTitle(asset)}
        </Text>
        <Text variant="label" tone={asset.status === 'failed' ? 'cut' : 'muted'}>
          {status}
        </Text>
        {asset.status === 'uploading' && upload !== undefined ? <ProgressBar value={upload} height={3} accessibilityLabel={`${asset.filename} ${status}`} /> : null}
      </View>
      {canRemove ? (
        <Pressable onPress={onRemove} accessibilityRole="button" accessibilityLabel={`Delete ${assetTitle(asset)}`} style={styles.iconHit} testID={`delete-${asset.id}`}>
          <Icon name="close" size={16} color={color.muted} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', gap: 10 },
  quoteRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  quote: { lineHeight: 20 },
  remove: { width: 28, height: 28, marginTop: -4, marginRight: -6, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  text: { flex: 1, gap: 3 },
  swap: { minWidth: 64, paddingHorizontal: 14 },
  add: { flexShrink: 0, paddingHorizontal: 16 },
  empty: {
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: color.dropBorder,
    backgroundColor: color.dropFill,
    borderRadius: radius.card,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  assetRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, paddingVertical: 8 },
  divider: { borderTopWidth: 1, borderTopColor: color.hairline },
  iconHit: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
