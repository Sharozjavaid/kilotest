import { useEffect, useMemo, useRef, useState } from 'react';
import { Image } from 'expo-image';
import { Alert, Platform, Pressable, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { edlStats, type RenderView, type VideoDetail } from '@kilo/edl';
import { getApi } from '@/api/client';
import { errorMessage } from '@/api/errors';
import { keys, useBatch, useMarkPosted, useVideo } from '@/api/queries';
import { saveToCameraRoll, shareVideo } from '@/export/media';
import { formatDuration, plural } from '@/lib/format';
import { VideoModal } from '@/components/VideoModal';
import { Card, ErrorState, Header, Icon, LoadingBlock, PillButton, ProgressBar, Row, Screen, Text, color, radius, shadow } from '@/ui';

interface Version {
  /** null for the base cut. */
  variantId: string | null;
  label: string;
  hookText: string;
  durationSec: number;
  render: RenderView | undefined;
}

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five'];

function notify(title: string, message: string) {
  if (Platform.OS === 'web') (globalThis as { alert?: (m: string) => void }).alert?.(`${title}\n\n${message}`);
  else Alert.alert(title, message);
}

/** Export (mock-up `Export`): final renders per version, save, share, mark as posted, next video. */
export default function ExportScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const video = useVideo(id);
  const v = video.data;

  if (video.isPending) {
    return (
      <Screen>
        <Header title="Ready to post" />
        <LoadingBlock />
      </Screen>
    );
  }
  if (!v || !v.edl) {
    return (
      <Screen>
        <Header title="Ready to post" />
        <ErrorState error={video.error ?? new Error('This video has no edit yet.')} onRetry={() => void video.refetch()} />
      </Screen>
    );
  }
  return <ExportBody video={v} />;
}

function ExportBody({ video }: { video: VideoDetail }) {
  const qc = useQueryClient();
  const edl = video.edl!;
  const batch = useBatch(video.batchId);
  const posted = useMarkPosted();
  const [requestError, setRequestError] = useState<unknown>(null);
  const [selected, setSelected] = useState(0);
  const [playing, setPlaying] = useState<Version | null>(null);
  const [busy, setBusy] = useState<null | 'save' | 'tiktok' | 'instagram'>(null);
  const [sharedTo, setSharedTo] = useState<'tiktok' | 'instagram' | null>(null);
  const requested = useRef(false);

  const versions: Version[] = useMemo(() => {
    const finals = video.renders.filter((r) => r.quality === 'final');
    const latest = (variantId: string | null) =>
      finals.filter((r) => r.variantId === variantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (edl.variants.length === 0) {
      return [{ variantId: null, label: 'Final cut', hookText: edl.segments.find((s) => s.keep && s.text)?.text ?? '', durationSec: edlStats(edl).keptSec, render: latest(null) }];
    }
    return edl.variants.map((x) => ({ variantId: x.id, label: x.label, hookText: x.hookText, durationSec: edlStats(edl, x.id).keptSec, render: latest(x.id) }));
  }, [video.renders, edl]);

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
  useEffect(() => {
    if (requested.current) return;
    if (video.status === 'ready_for_review') {
      requested.current = true;
      void createRenders();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video.status]);

  const allDone = versions.every((x) => x.render?.status === 'done' && x.render.url);
  const anyFailed = versions.some((x) => x.render?.status === 'failed');
  const n = versions.length;
  const current = versions[Math.min(selected, n - 1)]!;

  /** Render links are signed and expire; the screen may have been open a while, so sign them again. */
  const freshUrls = async (): Promise<Map<string, string>> => {
    const v = await getApi().getVideo(video.id);
    qc.setQueryData(keys.video(video.id), v);
    return new Map(v.renders.flatMap((r) => (r.url ? [[r.id, r.url] as const] : [])));
  };

  const saveAll = async () => {
    setBusy('save');
    try {
      const urls = await freshUrls();
      const count = await saveToCameraRoll(versions.map((x) => ({ url: urls.get(x.render!.id) ?? x.render!.url!, name: `${video.title} ${x.label}` })));
      notify('Saved', Platform.OS === 'web' ? `${plural(count, 'video')} downloaded.` : `${plural(count, 'video')} saved to your camera roll.`);
    } catch (e) {
      notify("Couldn't save", errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const send = async (platform: 'tiktok' | 'instagram') => {
    if (!current.render?.url) return;
    setBusy(platform);
    try {
      const url = (await freshUrls()).get(current.render.id) ?? current.render.url;
      await shareVideo(url, `${video.title} ${current.label}`, platform === 'tiktok' ? 'Send to TikTok' : 'Send to Instagram');
      setSharedTo(platform);
    } catch (e) {
      notify("Couldn't open the share sheet", errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  // ---- next video ----
  const list = batch.data?.videos ?? [];
  const idx = list.findIndex((x) => x.id === video.id);
  const next = idx >= 0 ? list[idx + 1] : undefined;
  const goNext = () => {
    if (!next) return router.replace('/');
    if (next.status === 'done') router.replace(`/export/${next.id}`);
    else if (next.status === 'ready_for_review' || next.status === 'rendering') router.replace(`/review/${next.id}`);
    else router.replace(`/batch/${next.batchId}`);
  };

  const headline = n > 1 ? `${n} versions of ${video.title}` : `${video.title} is ${allDone ? 'ready' : 'exporting'}`;
  const headline2 = n > 1 ? `Same body, ${WORDS[n] ?? n} different openings.` : allDone ? 'Your final cut, ready to post.' : 'Rendering at full quality. This takes a minute.';

  return (
    <Screen
      gap={16}
      footer={
        <>
          <PillButton
            label={Platform.OS === 'web' ? (n > 1 ? `Download all ${n}` : 'Download') : n > 1 ? `Save all ${n} to camera roll` : 'Save to camera roll'}
            icon="download"
            onPress={saveAll}
            disabled={!allDone}
            loading={busy === 'save'}
          />
          <View style={styles.two}>
            <PillButton variant="secondary" label="Send to TikTok" style={{ flex: 1 }} disabled={!current.render?.url} loading={busy === 'tiktok'} onPress={() => void send('tiktok')} />
            <PillButton variant="secondary" label="Send to Instagram" style={{ flex: 1 }} disabled={!current.render?.url} loading={busy === 'instagram'} onPress={() => void send('instagram')} />
          </View>
          <PillButton variant="text" label={next ? `Next video, ${idx + 2} of ${list.length}` : 'Back to home'} onPress={goNext} />
        </>
      }
    >
      <Header title="Ready to post" onBack={() => (router.canGoBack() ? router.back() : router.replace(`/review/${video.id}`))} />

      <View style={{ gap: 4 }}>
        <Text variant="headline">{headline}</Text>
        <Text variant="body" tone="muted" style={{ fontSize: 14 }}>
          {headline2}
        </Text>
      </View>

      <View style={styles.grid}>
        {versions.map((x, i) => (
          <VersionTile
            key={x.variantId ?? 'base'}
            version={x}
            selected={i === selected}
            single={n === 1}
            thumbnailUrl={video.thumbnailUrl}
            onPress={() => {
              setSelected(i);
              if (x.render?.status === 'done' && x.render.url) setPlaying(x);
            }}
          />
        ))}
        {n === 1 ? <View style={{ flex: 2 }} /> : null}
      </View>

      {requestError || anyFailed ? (
        <Card gap={8}>
          <Text variant="body" weight={600} tone="cut">
            {anyFailed ? 'A version failed to export' : "Couldn't start the export"}
          </Text>
          <Text variant="secondary" tone="muted">
            {requestError ? errorMessage(requestError) : versions.find((x) => x.render?.status === 'failed')?.render?.error ?? 'Something went wrong while rendering.'}
          </Text>
          <PillButton variant="secondary" height={44} icon="refresh" label="Try again" onPress={() => void createRenders()} />
        </Card>
      ) : null}

      <Card padding={0} paddingHorizontal={16}>
        <InfoRow label="Format" value="1080 × 1920, vertical" />
        <InfoRow divider label="Frame rate" value={`${Math.round(edl.fps)} fps, same as recorded`} />
        <InfoRow divider label="Captions" value={edl.captions.enabled ? 'Burned in' : 'Off, add in the app you post to'} />
      </Card>

      <Text variant="secondary" tone="muted">
        Send to TikTok or Instagram opens your phone's share sheet with {n > 1 ? current.label : 'this video'}. You pick the app and post from there; Kilo doesn't post for you.
      </Text>

      {sharedTo || video.postedAt ? (
        <Card gap={8}>
          {video.postedAt ? (
            <Row minHeight={44} title="Marked as posted" subtitle="Counts toward this week's goal." right={<Icon name="check" color={color.accent} />} />
          ) : (
            <>
              <Text variant="body" weight={500}>
                Posted it on {sharedTo === 'tiktok' ? 'TikTok' : 'Instagram'}?
              </Text>
              <PillButton
                variant="secondary"
                height={44}
                label="Yes, mark as posted"
                loading={posted.isPending}
                onPress={() => posted.mutate({ videoId: video.id, platform: sharedTo! })}
              />
            </>
          )}
        </Card>
      ) : (
        <PillButton variant="text" label="I posted this, mark as posted" onPress={() => posted.mutate({ videoId: video.id, platform: 'other' })} loading={posted.isPending} />
      )}
      {posted.isError ? (
        <Text variant="label" tone="cut">
          {errorMessage(posted.error)}
        </Text>
      ) : null}

      <VideoModal url={playing?.render?.url ?? null} title={`${video.title} · ${playing?.label ?? ''}`} onClose={() => setPlaying(null)} />
    </Screen>
  );
}

function VersionTile({ version, selected, single, thumbnailUrl, onPress }: { version: Version; selected: boolean; single: boolean; thumbnailUrl: string | null; onPress: () => void }) {
  const r = version.render;
  const done = r?.status === 'done';
  const progress = r ? r.progress : 0;
  const state = done ? 'Tap to play' : r?.status === 'failed' ? 'Failed' : `Exporting ${Math.round(progress * 100)}%`;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${version.label}, ${formatDuration(version.durationSec)}. ${state}`}
      accessibilityState={{ selected }}
      style={styles.tileWrap}
    >
      <View style={[styles.tile, selected && !single && [styles.tileSelected, shadow.selected]]}>
        {thumbnailUrl ? (
          <>
            <Image source={{ uri: thumbnailUrl }} style={styles.tileImage} contentFit="cover" accessibilityIgnoresInvertColors />
            <View style={styles.tileVeil} />
          </>
        ) : null}
        {done ? (
          <View style={styles.playBadge}>
            <Icon name="play" size={14} />
          </View>
        ) : (
          <View style={{ gap: 6, alignSelf: 'stretch' }}>
            <Text variant="label" weight={600} tone={r?.status === 'failed' ? 'cut' : 'muted'}>
              {state}
            </Text>
            <ProgressBar value={progress} height={4} tone={r?.status === 'failed' ? 'cut' : 'accent'} />
          </View>
        )}
        {/* In a View so it stacks above the absolutely positioned picture on web. */}
        <View>
          <Text variant="label" weight={600} style={{ lineHeight: 15 }} numberOfLines={5}>
            {version.hookText ? `"${version.hookText}"` : ''}
          </Text>
        </View>
      </View>
      <Text variant="secondary" weight={selected ? 600 : 400} tone={selected ? 'ink' : 'muted'}>
        {version.label} · {formatDuration(version.durationSec)}
      </Text>
    </Pressable>
  );
}

function InfoRow({ label, value, divider }: { label: string; value: string; divider?: boolean }) {
  return (
    <View style={[styles.info, divider && styles.divider]}>
      <Text variant="body" tone="muted" style={{ fontSize: 14 }}>
        {label}
      </Text>
      <Text variant="body" weight={500} style={{ fontSize: 14 }}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  two: { flexDirection: 'row', gap: 10 },
  grid: { flexDirection: 'row', gap: 10 },
  tileWrap: { flex: 1, gap: 8 },
  tile: {
    height: 196,
    borderRadius: radius.row,
    backgroundColor: color.track,
    padding: 8,
    justifyContent: 'space-between',
    borderWidth: 2,
    borderColor: 'transparent',
    overflow: 'hidden',
  },
  tileSelected: { borderColor: color.accent },
  tileImage: { ...StyleSheet.absoluteFill, borderRadius: radius.row - 2 },
  // Keeps the hook text readable over any frame.
  tileVeil: { ...StyleSheet.absoluteFill, borderRadius: radius.row - 2, backgroundColor: 'rgba(255,255,255,0.62)' },
  playBadge: { width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.9)', alignItems: 'center', justifyContent: 'center' },
  info: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 48 },
  divider: { borderTopWidth: 1, borderTopColor: color.hairline },
});
