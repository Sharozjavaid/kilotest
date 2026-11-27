import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import type { BatchSummary, GoalView } from '@kilo/edl';
import { useHome } from '@/api/queries';
import { batchCardState, finishedSubtitle, goalLine, plural, reviewSubtitle } from '@/lib/format';
import { VideoRow } from '@/components/VideoRow';
import {
  Card,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  ProgressBar,
  Screen,
  SectionLabel,
  Skeleton,
  SkeletonRows,
  StepBar,
  Text,
  Wordmark,
  accentGloss,
  color,
  radius,
  shadow,
  type IconName,
} from '@/ui';

/** Home (mock-up `Main`). */
export default function HomeScreen() {
  const home = useHome();
  const data = home.data;
  const firstTime = !!data && data.activeBatches.length === 0 && data.readyToReview.length === 0 && data.recent.length === 0;

  return (
    <Screen bottomInset={false} refreshing={home.isRefetching} onRefresh={() => void home.refetch()} testID="home">
      <View style={styles.top}>
        <View style={styles.brand}>
          <Wordmark />
          <Text variant="secondary" tone="muted">
            AI video editor
          </Text>
        </View>
        <View style={styles.topActions}>
          <IconButton icon="list" label="All videos" onPress={() => router.push('/videos')} />
          <IconButton icon="settings" label="Settings" onPress={() => router.push('/you')} />
        </View>
      </View>

      {home.isPending ? (
        <Card gap={12}>
          <Skeleton width="40%" height={13} />
          <Skeleton width="70%" height={24} />
          <Skeleton height={8} />
        </Card>
      ) : data ? (
        <GoalCard goal={data.goal} />
      ) : null}

      <View style={styles.tiles}>
        <Tile primary icon="upload" label="Upload clips" onPress={() => router.push('/new-batch')} />
        <Tile icon="camera" label="Record with script" onPress={() => router.push('/record')} />
      </View>

      {home.isPending ? (
        <SkeletonRows count={3} />
      ) : home.isError && !data ? (
        <ErrorState error={home.error} onRetry={() => void home.refetch()} />
      ) : data ? (
        <>
          {data.activeBatches.map((b) => (
            <BatchCard key={b.id} batch={b} />
          ))}

          {firstTime ? (
            <EmptyState
              icon="videos"
              title="Your first video starts here"
              body="Upload a few raw clips. Kilo cuts the dead air, retakes and filler, and you check the result in a minute."
              action={{ label: 'Upload clips', onPress: () => router.push('/new-batch') }}
            />
          ) : null}

          {data.readyToReview.length > 0 ? (
            <View style={styles.list}>
              <SectionLabel>Ready to review</SectionLabel>
              {/* Newest batch first, each batch in the order its videos were put in (the server's order). */}
              {data.readyToReview.slice(0, HOME_READY_ROWS).map((v, i) => (
                <VideoRow key={v.id} video={v} subtitle={reviewSubtitle(v)} divider={i > 0} onPress={() => router.push(`/review/${v.id}`)} />
              ))}
              {data.readyToReview.length > HOME_READY_ROWS ? (
                <SeeAll label={`See all ${data.readyToReview.length} to review`} onPress={() => router.push('/videos?filter=review')} />
              ) : null}
            </View>
          ) : null}

          {data.recent.length > 0 ? (
            <View style={styles.list}>
              <SectionLabel>Finished</SectionLabel>
              {data.recent.slice(0, HOME_FINISHED_ROWS).map((v, i) => (
                <VideoRow
                  key={v.id}
                  video={v}
                  subtitle={finishedSubtitle(v)}
                  divider={i > 0}
                  onPress={() => router.push(`/export/${v.id}`)}
                />
              ))}
              <SeeAll label="All videos" onPress={() => router.push('/videos?filter=finished')} />
            </View>
          ) : !firstTime ? (
            <SeeAll label="All videos" onPress={() => router.push('/videos')} />
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

function GoalCard({ goal }: { goal: GoalView }) {
  if (goal.videosPerWeek === 0) {
    return (
      <Card gap={8} onPress={() => router.push('/goal')} accessibilityLabel="Set a weekly goal">
        <Text variant="secondary" tone="muted">
          This week's goal
        </Text>
        <Text variant="goal">Set a weekly goal</Text>
        <Text variant="secondary" tone="muted">
          Pick how many videos you want to post each week.
        </Text>
      </Card>
    );
  }
  const line = goalLine(goal.postedThisWeek, goal.videosPerWeek);
  return (
    <Card gap={12} onPress={() => router.push('/goal')} accessibilityLabel={`This week's goal: ${line}`} accessibilityHint="Opens your goal">
      <View style={styles.spread}>
        <Text variant="secondary" tone="muted">
          This week's goal
        </Text>
        <Text variant="secondary" tone="muted">
          {goal.streakWeeks > 0 ? `${plural(goal.streakWeeks, 'week')} streak` : 'Resets Monday'}
        </Text>
      </View>
      <Text variant="goal">{line}</Text>
      <StepBar done={goal.postedThisWeek} total={goal.videosPerWeek} accessibilityLabel={line} />
    </Card>
  );
}

function Tile({ icon, label, onPress, primary }: { icon: IconName; label: string; onPress: () => void; primary?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.tile, primary ? shadow.gloss : [styles.tileGlass, shadow.surface], pressed && { opacity: 0.85 }]}
    >
      {primary ? (
        <LinearGradient colors={accentGloss.colors} locations={accentGloss.locations} style={[StyleSheet.absoluteFill, { borderRadius: radius.card }]} />
      ) : null}
      {/* Wrapped so the content stacks above the absolutely positioned gloss on web. */}
      <View>
        <Icon name={icon} size={22} strokeWidth={2.2} color={primary ? color.white : color.ink} />
      </View>
      <Text variant="bodyLg" tone={primary ? 'white' : 'ink'}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Home shows this many ready videos, then a link to the rest in All videos. */
const HOME_READY_ROWS = 30;
/** And this many finished ones (the server sends the latest 50). */
const HOME_FINISHED_ROWS = 10;

function SeeAll({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [styles.seeAll, pressed && { opacity: 0.6 }]}>
      <Text variant="secondary" weight={600} tone="accent">
        {label}
      </Text>
      <Icon name="chevronRight" size={16} color={color.accent} />
    </Pressable>
  );
}

/** A batch stays on Home until every video in it is finished: uploading, editing, to review, exporting. */
function BatchCard({ batch }: { batch: BatchSummary }) {
  const st = batchCardState(batch);
  const title = `Batch of ${batch.total} ${st.phrase}`;
  return (
    <Card gap={10} onPress={() => router.push(`/batch/${batch.id}`)} accessibilityLabel={`${title}, ${st.done} done`} accessibilityHint="Shows each video's progress">
      <View style={styles.spread}>
        <Text variant="body" weight={600}>
          {title}
        </Text>
        <Text variant="secondary" tone="muted">
          {st.done} done
        </Text>
      </View>
      <ProgressBar value={st.progress} accessibilityLabel={st.progressLabel} />
      <Text variant="secondary" tone={st.failed ? 'cut' : 'muted'}>
        {st.line}
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 44 },
  brand: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  topActions: { flexDirection: 'row', gap: 8 },
  seeAll: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44 },
  spread: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  tiles: { flexDirection: 'row', gap: 12 },
  tile: { flex: 1, height: 96, borderRadius: radius.card, padding: 14, justifyContent: 'space-between' },
  tileGlass: { backgroundColor: color.surface, borderWidth: 1, borderColor: color.hairline },
  list: { gap: 4 },
});
