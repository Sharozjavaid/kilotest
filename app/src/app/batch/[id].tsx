import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import type { VideoSummary } from '@kilo/edl';
import { useBatch, useRetryVideo } from '@/api/queries';
import { errorMessage } from '@/api/errors';
import { getUploadQueue, useUploadJobs } from '@/uploads/UploadManager';
import { progressByVideo, type VideoUploadProgress } from '@/uploads/queue';
import { batchDoneCount, plural, reviewSubtitle, statusLabel } from '@/lib/format';
import { Card, ErrorState, Header, Icon, LoadingBlock, PillButton, ProgressBar, Screen, Text, Thumb, color } from '@/ui';

/** One batch: per-video upload and editing progress, failures with retry. */
export default function BatchScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const batch = useBatch(id);
  const jobs = useUploadJobs();
  const uploads = useMemo(() => progressByVideo(jobs), [jobs]);
  const firstReady = batch.data?.videos.find((v) => v.status === 'ready_for_review');

  return (
    <Screen
      gap={12}
      refreshing={batch.isRefetching}
      onRefresh={() => void batch.refetch()}
      footer={firstReady ? <PillButton label="Review the first one" onPress={() => router.push(`/review/${firstReady.id}`)} /> : undefined}
    >
      <Header
        title={batch.data ? `Batch of ${batch.data.total}` : 'Batch'}
        meta={batch.data ? `${batchDoneCount(batch.data)} of ${batch.data.total} ready` : undefined}
        onBack={() => router.replace('/')}
      />
      {batch.isPending ? (
        <LoadingBlock />
      ) : batch.isError ? (
        <ErrorState error={batch.error} onRetry={() => void batch.refetch()} />
      ) : (
        <>
          {batch.data!.videos.some((x) => x.status === 'uploading') ? (
            <Text variant="secondary" tone="muted">
              Uploads carry on in the background where your phone allows, and pick up again when you reopen Kilo.
            </Text>
          ) : batch.data!.videos.some((x) => x.status === 'queued' || x.status === 'analyzing') ? (
            <Text variant="secondary" tone="muted">
              You'll get a notification when the batch is ready.
            </Text>
          ) : null}
          {batch.data!.videos.map((v) => (
            <VideoProgressCard key={v.id} video={v} upload={uploads.get(v.id)} />
          ))}
        </>
      )}
    </Screen>
  );
}

function VideoProgressCard({ video, upload }: { video: VideoSummary; upload?: VideoUploadProgress }) {
  const retry = useRetryVideo();
  const uploadFailed = !!upload && upload.failed > 0;
  const ready = video.status === 'ready_for_review' || video.status === 'done' || video.status === 'rendering';

  let line: string;
  let progress: number | null = null;
  if (video.status === 'uploading') {
    const pct = Math.round((upload?.fraction ?? 0) * 100);
    line = uploadFailed ? 'Upload stopped' : upload ? `Uploading ${pct}% · ${upload.filesDone} of ${plural(upload.files, "file")} in` : 'Waiting to upload from this phone';
    progress = upload?.fraction ?? 0;
  } else if (video.status === 'queued') {
    line = 'Uploaded. Waiting to edit';
    progress = 0.15;
  } else if (video.status === 'analyzing') {
    line = 'Editing: finding the best takes';
    progress = 0.6;
  } else if (ready) {
    line = reviewSubtitle(video);
  } else {
    line = statusLabel(video.status);
  }

  return (
    <Card
      gap={10}
      onPress={ready ? () => router.push(video.status === 'done' ? `/export/${video.id}` : `/review/${video.id}`) : undefined}
      accessibilityLabel={`${video.title}, ${video.status === 'failed' ? "couldn't be edited" : line}`}
    >
      <View style={styles.row}>
        <Thumb uri={video.thumbnailUrl} />
        <View style={{ flex: 1, gap: 3 }}>
          <Text variant="body" weight={500} numberOfLines={1}>
            {video.title}
          </Text>
          <Text variant="secondary" tone={video.status === 'failed' || uploadFailed ? 'cut' : 'muted'} numberOfLines={2}>
            {video.status === 'failed' ? "Couldn't edit this video" : line}
          </Text>
        </View>
        {ready ? <Icon name="chevronRight" size={18} color={color.muted} /> : null}
        {video.status === 'done' ? <Icon name="check" size={18} color={color.accent} /> : null}
      </View>
      {progress !== null && video.status !== 'failed' ? <ProgressBar value={progress} accessibilityLabel={line} tone={uploadFailed ? 'cut' : 'accent'} /> : null}
      {video.status === 'failed' ? (
        <>
          <Text variant="secondary">{video.error ?? 'Something went wrong while editing.'}</Text>
          {retry.isError ? (
            <Text variant="label" tone="cut">
              {errorMessage(retry.error)}
            </Text>
          ) : null}
          <PillButton variant="secondary" height={44} icon="refresh" label="Try again" loading={retry.isPending} onPress={() => retry.mutate(video.id)} accessibilityLabel={`Try editing ${video.title} again`} />
        </>
      ) : null}
      {uploadFailed && video.status === 'uploading' ? (
        <>
          <Text variant="secondary">{upload!.error ? `Last error: ${upload!.error}` : 'Some files did not upload.'}</Text>
          <PillButton variant="secondary" height={44} icon="refresh" label="Retry upload" onPress={() => getUploadQueue().retry(upload!.failedIds)} accessibilityLabel={`Retry uploading ${video.title}`} />
        </>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
});
