import { memo, useEffect, useMemo, useRef } from 'react';
import { Platform, View } from 'react-native';
import Animated, { Easing, FadeIn, ReduceMotion, withSpring, withTiming, type EntryExitAnimationFunction } from 'react-native-reanimated';
import { router, useLocalSearchParams } from 'expo-router';
import type { VideoSummary } from '@kilo/edl';
import { useBatch, useRetryVideo } from '@/api/queries';
import { errorMessage } from '@/api/errors';
import { getUploadQueue, useUploadJobs, useUploadsOffline } from '@/uploads/UploadManager';
import { batchUploadProgress, progressByVideo, videoUploadState, type BatchUploadProgress, type VideoUploadProgress, type VideoUploadState } from '@/uploads/queue';
import { batchRowState, firstReadyNow } from '@/library/batchRow';
import { FOOTER_BUTTON } from '@/components/sizes';
import { batchDoneCount, plural } from '@/lib/format';
import {
  Card,
  Chip,
  ErrorState,
  LoadingBlock,
  PillButton,
  PressableScale,
  ProgressBar,
  ProgressRing,
  Screen,
  SymbolIcon,
  Text,
  Thumb,
  haptic,
  makeStyles,
  springs,
  useColors,
  useLayoutMotion,
  useReducedMotionSetting,
} from '@/ui';

/**
 * One batch (design brief 4.5): the upload summary, then a row per video with its progress ring
 * in place (never a blocking spinner), the "Review" chip once it is ready, failures with Try again
 * under the row, and "Review the first one" in the glass footer once any video is ready. Polls
 * while in front (`useBatch`).
 */
export default function BatchScreen() {
  const s = useStyles();
  const m = useLayoutMotion();
  const { id } = useLocalSearchParams<{ id: string }>();
  const batch = useBatch(id);
  const jobs = useUploadJobs();
  const offline = useUploadsOffline();
  const uploads = useMemo(() => progressByVideo(jobs), [jobs]);
  const overall = useMemo(() => (id ? batchUploadProgress(jobs, id) : null), [jobs, id]);
  const videos = batch.data?.videos;
  const firstReady = videos?.find((v) => v.status === 'ready_for_review');
  useFirstReadyHaptic(videos);

  return (
    <Screen
      appearance="auto"
      gap={12}
      refreshing={batch.isRefetching}
      onRefresh={() => void batch.refetch()}
      header={{
        title: batch.data ? `Batch of ${batch.data.total}` : 'Batch',
        meta: batch.data ? `${batchDoneCount(batch.data)} of ${batch.data.total} ready` : undefined,
      }}
      footerGlass
      footer={
        firstReady ? (
          <Animated.View entering={m.appear}>
            <PillButton label="Review the first one" height={FOOTER_BUTTON} onPress={() => router.push(`/review/${firstReady.id}`)} />
          </Animated.View>
        ) : undefined
      }
    >
      {batch.isPending ? (
        <LoadingBlock />
      ) : batch.isError || !videos ? (
        <ErrorState error={batch.error} onRetry={() => void batch.refetch()} />
      ) : (
        <>
          {overall && overall.filesDone < overall.files ? <UploadSummary progress={overall} offline={offline} /> : null}
          {videos.some((x) => x.status === 'uploading') ? (
            <Text variant="secondary" tone="muted">
              This phone sends one video's files at a time, so the first ones start editing while the rest upload. Uploads carry on in the background where your phone allows, and pick up again when you reopen Kilo.
            </Text>
          ) : videos.some((x) => x.status === 'queued' || x.status === 'analyzing') ? (
            <Text variant="secondary" tone="muted">
              You'll get a notification when the batch is ready.
            </Text>
          ) : null}
          <Card padding={0} paddingHorizontal={16}>
            {videos.map((v, i) => (
              <VideoProgressRow
                key={v.id}
                video={v}
                divider={i > 0}
                upload={uploads.get(v.id)}
                uploadState={v.status === 'uploading' ? videoUploadState(jobs, v.id, offline) : null}
              />
            ))}
          </Card>
        </>
      )}
      <View style={s.end} />
    </Screen>
  );
}

/** The `selection` haptic when the batch's first video becomes ready while the screen is open. */
function useFirstReadyHaptic(videos: readonly VideoSummary[] | undefined) {
  const before = useRef<number | null>(null);
  useEffect(() => {
    if (!videos) return;
    const now = videos.filter((v) => v.status === 'ready_for_review' || v.status === 'rendering' || v.status === 'done').length;
    if (firstReadyNow(before.current, now)) haptic('selection');
    before.current = now;
  }, [videos]);
}

/** Everything this phone is sending for the batch, at the top of the screen. */
function UploadSummary({ progress, offline }: { progress: BatchUploadProgress; offline: boolean }) {
  const pct = Math.round(progress.fraction * 100);
  const title = offline ? 'Uploads paused: no connection' : progress.failed ? 'Some uploads stopped' : 'Uploading from this phone';
  const line = offline
    ? `${progress.filesDone} of ${plural(progress.files, 'file')} in. Finished files stay in; the rest carry on when you're back online.`
    : `${progress.filesDone} of ${plural(progress.files, 'file')} in · ${pct}%${progress.videosWaiting ? ` · ${plural(progress.videosWaiting, 'video')} waiting on this phone` : ''}`;
  return (
    <Card gap={8} testID="upload-summary" accessibilityLabel={`${title}. ${line}`}>
      <Text variant="body" weight={600} tone={offline || progress.failed ? 'cut' : 'ink'}>
        {title}
      </Text>
      <ProgressBar value={progress.fraction} accessibilityLabel={`${pct}% uploaded`} tone={offline || progress.failed ? 'cut' : 'accent'} />
      <Text variant="secondary" tone="muted" tabular>
        {line}
      </Text>
    </Card>
  );
}

/** The chip arriving where the ring was: 0.9 to 1 on the `select` spring, with a 150 ms fade. */
const chipIn: EntryExitAnimationFunction = () => {
  'worklet';
  const fade = { duration: 150, easing: Easing.bezier(0.2, 0.8, 0.2, 1), reduceMotion: ReduceMotion.System };
  return {
    initialValues: { opacity: 0, transform: [{ scale: 0.9 }] },
    animations: { opacity: withTiming(1, fade), transform: [{ scale: withSpring(1, { ...springs.select, reduceMotion: ReduceMotion.System }) }] },
  };
};
const ringIn = FadeIn.duration(150);
const native = Platform.OS !== 'web';

interface RowProps {
  video: VideoSummary;
  divider: boolean;
  upload?: VideoUploadProgress;
  uploadState: VideoUploadState | null;
}

/** Rows re-render when their own video or upload changes, not on every byte of another video's upload. */
function sameRow(a: RowProps, b: RowProps): boolean {
  const ua = a.upload;
  const ub = b.upload;
  const sameUpload = ua === ub || (!!ua && !!ub && ua.fraction === ub.fraction && ua.filesDone === ub.filesDone && ua.failed === ub.failed && ua.error === ub.error && ua.files === ub.files);
  return a.video === b.video && a.divider === b.divider && a.uploadState === b.uploadState && sameUpload;
}

const VideoProgressRow = memo(function VideoProgressRow({ video, divider, upload, uploadState }: RowProps) {
  const s = useStyles();
  const c = useColors();
  const reduced = useReducedMotionSetting();
  const retry = useRetryVideo();
  const st = batchRowState(video, upload, uploadState);
  const uploadFailed = !!upload && upload.failed > 0;

  const trailing =
    st.trailing === 'ring' ? (
      <Animated.View key="ring" entering={native && !reduced ? ringIn : undefined}>
        <ProgressRing value={st.ring} size={28} tone={st.cut ? 'cut' : 'accent'} accessibilityLabel={st.line} />
      </Animated.View>
    ) : st.trailing === 'review' ? (
      <Animated.View key="chip" entering={native ? chipIn : undefined}>
        <Chip kind="status" label="Review" />
      </Animated.View>
    ) : st.trailing === 'posted' ? (
      <SymbolIcon name="check" size={18} strokeWidth={2.4} color={c.accent} />
    ) : st.trailing === 'failed' ? (
      <SymbolIcon name="alert" filled size={20} color={c.cut} />
    ) : null;

  const body = (
    <>
      <View style={s.row}>
        <View>
          <Thumb uri={video.thumbnailUrl} cacheKey={video.id} width={44} height={78} r={8} />
          {st.veil ? <View style={s.veil} pointerEvents="none" /> : null}
        </View>
        <View style={s.text}>
          <Text variant="body" weight={500} numberOfLines={1}>
            {video.title}
          </Text>
          <Text variant="secondary" tone={st.cut ? 'cut' : 'muted'} numberOfLines={2} tabular>
            {st.line}
          </Text>
          {video.status === 'failed' ? (
            <>
              <Text variant="secondary">{video.error ?? 'Something went wrong while editing.'}</Text>
              {retry.isError ? (
                <Text variant="label" tone="cut">
                  {errorMessage(retry.error)}
                </Text>
              ) : null}
              <PillButton variant="secondary" surface="content" height={44} icon="refresh" label="Try again" loading={retry.isPending} onPress={() => retry.mutate(video.id)} accessibilityLabel={`Try editing ${video.title} again`} style={s.inlineButton} />
            </>
          ) : null}
          {uploadFailed && video.status === 'uploading' ? (
            <>
              <Text variant="secondary">{upload!.error ? `Last error: ${upload!.error}` : 'Some files did not upload.'}</Text>
              <PillButton variant="secondary" surface="content" height={44} icon="refresh" label="Retry upload" onPress={() => getUploadQueue().retry(upload!.failedIds)} accessibilityLabel={`Retry uploading ${video.title}`} style={s.inlineButton} />
            </>
          ) : null}
        </View>
        <View style={s.trailing}>{trailing}</View>
        {st.href ? <SymbolIcon name="chevronRight" size={13} strokeWidth={2.4} color={c.muted} /> : null}
      </View>
    </>
  );

  const label = `${video.title}, ${video.status === 'failed' ? "couldn't be edited" : st.line}`;
  if (st.href) {
    const href = st.href;
    return (
      <PressableScale onPress={() => router.push(href)} motion="row" pressedBackgroundColor={c.pressedRow} accessibilityRole="button" accessibilityLabel={label} style={[s.cell, divider && s.divider]}>
        {body}
      </PressableScale>
    );
  }
  return (
    <View style={[s.cell, divider && s.divider]} accessibilityLabel={label}>
      {body}
    </View>
  );
}, sameRow);

const useStyles = makeStyles((t) => ({
  cell: { paddingVertical: 10, marginHorizontal: -16, paddingHorizontal: 16 },
  divider: { borderTopWidth: 1, borderTopColor: t.color.hairline },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  text: { flex: 1, gap: 4 },
  trailing: { minWidth: 28, alignItems: 'flex-end' },
  // The clip's first frame under a 30% veil while it is edited (brief 4.5).
  veil: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 8, backgroundColor: t.scheme === 'dark' ? 'rgba(10,15,26,0.3)' : 'rgba(255,255,255,0.3)' },
  inlineButton: { alignSelf: 'flex-start', marginTop: 4 },
  end: { height: 1 },
}));
