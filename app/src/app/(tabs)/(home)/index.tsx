import { useEffect, useRef, type ReactNode } from 'react';
import { Alert, Platform, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { router, useIsFocused } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import type { BatchSummary, GoalView, VideoSummary } from '@kilo/edl';
import { useHome } from '@/api/queries';
import { errorMessage } from '@/api/errors';
import { batchCardState, finishedSubtitle, goalLine, plural, reviewSubtitle } from '@/lib/format';
import { newlyReady, readyToastText } from '@/library/arrivals';
import { pickFromLibrary } from '@/newBatch/picker';
import { setPendingPicks } from '@/newBatch/handoff';
import { VideoRow } from '@/components/VideoRow';
import {
  ActionMenu,
  Card,
  EmptyState,
  ErrorState,
  GlassGroup,
  IconButton,
  PressableScale,
  ProgressBar,
  Screen,
  Skeleton,
  SkeletonRows,
  StepBar,
  SymbolIcon,
  Text,
  Wordmark,
  makeStyles,
  radius,
  toast,
  useColors,
  useLayoutMotion,
  useTheme,
  type IconName,
  type MenuItem,
} from '@/ui';

const ios = Platform.OS === 'ios';

/** Home shows this many ready videos, then a link to the rest in All videos. */
const HOME_READY_ROWS = 30;
/** And this many finished ones (the server sends the latest 50). */
const HOME_FINISHED_ROWS = 10;

/**
 * "Upload clips": on a phone the system photo picker opens straight away, and the New batch sheet
 * opens only after it returns, already holding the clips (brief 3). On web the New batch screen
 * keeps its own "Pick clips" step (the browser suite picks files there).
 */
async function uploadClips() {
  if (Platform.OS === 'web') return router.push('/new-batch');
  try {
    const files = await pickFromLibrary('videos');
    if (!files.length) return;
    setPendingPicks(files);
    router.push('/new-batch');
  } catch (e) {
    Alert.alert("Couldn't open your library", errorMessage(e));
  }
}

const recordWithScript = () => router.push('/record');
const openAllVideos = () => router.push('/videos');

/** The New (+) menu (brief 3): the two ways a video starts, each with a one-line subtitle. */
const NEW_MENU: MenuItem[] = [
  { label: 'Upload clips', subtitle: 'Kilo cuts them for you', icon: 'upload', sf: 'photo.on.rectangle.angled', onPress: () => void uploadClips() },
  { label: 'Record with script', subtitle: 'Read a script, one line at a time', icon: 'camera', sf: 'video', onPress: recordWithScript },
];

/**
 * Videos, the Home tab (design brief 4.2): wordmark row, goal card, the two creation tiles, the
 * batches in progress, "Ready to review", "Finished". On iOS the header is the transparent native
 * bar with the glass capsule (All videos, New); elsewhere the same two buttons sit in the
 * wordmark row. Polls only while in front (`useHome`).
 */
export default function HomeScreen() {
  const home = useHome();
  const data = home.data;
  const m = useLayoutMotion();
  const firstTime = !!data && data.activeBatches.length === 0 && data.readyToReview.length === 0 && data.recent.length === 0;

  // First load staggers the sections in (`appear`); anything that arrives later uses `listInsert`.
  const loaded = useRef(false);
  useEffect(() => {
    if (data) loaded.current = true;
  }, [data]);
  const arrive = (i: number) => (loaded.current ? m.listInsert : m.appearAt(i));

  useReadyToast(data?.readyToReview);

  return (
    <Screen
      appearance="auto"
      bottomInset={false}
      refreshing={home.isRefetching}
      onRefresh={() => void home.refetch()}
      testID="home"
      header={
        ios
          ? {
              title: '',
              noBack: true,
              actions: [
                { label: 'All videos', icon: 'list', onPress: openAllVideos },
                { label: 'New', icon: 'plus', onPress: () => undefined, menu: NEW_MENU },
              ],
            }
          : undefined
      }
    >
      <TopRow />

      {home.isPending ? (
        <Card gap={12}>
          <Skeleton width="40%" height={13} />
          <Skeleton width="70%" height={24} />
          <Skeleton height={8} />
        </Card>
      ) : data ? (
        <Animated.View entering={m.appearAt(0)} layout={m.listLayout}>
          <GoalCard goal={data.goal} />
        </Animated.View>
      ) : null}

      <Animated.View style={styles.tiles} layout={m.listLayout}>
        <Tile primary icon="upload" label="Upload clips" onPress={() => void uploadClips()} />
        <Tile icon="camera" label="Record with script" onPress={recordWithScript} />
      </Animated.View>

      {home.isPending ? (
        <SkeletonRows count={3} />
      ) : home.isError && !data ? (
        <ErrorState error={home.error} onRetry={() => void home.refetch()} />
      ) : data ? (
        <>
          {data.activeBatches.map((b, i) => (
            <Animated.View key={b.id} entering={arrive(1 + i)} exiting={m.listRemove} layout={m.listLayout}>
              <BatchCard batch={b} />
            </Animated.View>
          ))}

          {firstTime ? (
            <Animated.View entering={m.appearAt(1)}>
              <EmptyState
                icon="videos"
                title="Your first video starts here"
                body="Upload a few raw clips. Kilo cuts the dead air, retakes and filler, and you check the result in a minute."
              />
            </Animated.View>
          ) : null}

          {data.readyToReview.length > 0 ? (
            <Section title="Ready to review" entering={arrive(1 + data.activeBatches.length)}>
              {/* Newest batch first, each batch in the order its videos were put in (the server's order). */}
              {data.readyToReview.slice(0, HOME_READY_ROWS).map((v, i) => (
                <ListRow key={v.id} insert={loaded.current}>
                  <VideoRow video={v} subtitle={reviewSubtitle(v)} divider={i > 0} onPress={() => router.push(`/review/${v.id}`)} />
                </ListRow>
              ))}
              {data.readyToReview.length > HOME_READY_ROWS ? (
                <SeeAll label={`See all ${data.readyToReview.length} to review`} onPress={() => router.push('/videos?filter=review')} />
              ) : null}
            </Section>
          ) : null}

          {data.recent.length > 0 ? (
            <Section title="Finished" entering={arrive(2 + data.activeBatches.length)}>
              {data.recent.slice(0, HOME_FINISHED_ROWS).map((v, i) => (
                <ListRow key={v.id} insert={loaded.current}>
                  <VideoRow video={v} subtitle={finishedSubtitle(v)} divider={i > 0} onPress={() => router.push(`/export/${v.id}`)} />
                </ListRow>
              ))}
              <SeeAll label="All videos" onPress={() => router.push('/videos?filter=finished')} />
            </Section>
          ) : !firstTime ? (
            <SeeAll label="All videos" onPress={openAllVideos} />
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

/**
 * A light toast when a video moves into "Ready to review" while Home is in front (brief 4.2).
 * Quiet on the first load and while Home is behind another screen.
 */
function useReadyToast(ready: readonly VideoSummary[] | undefined) {
  const focused = useIsFocused();
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!ready) return;
    const text = focused ? readyToastText(newlyReady(seen.current, ready)) : null;
    seen.current = new Set(ready.map((v) => v.id));
    if (text) toast.info(text);
  }, [ready, focused]);
}

/** The wordmark row; off iOS it also holds the All videos and New buttons (iOS has them in the native bar). */
function TopRow() {
  const s = useStyles();
  return (
    <View style={s.top}>
      <View style={s.brand}>
        <Wordmark />
        <Text variant="secondary" tone="muted">
          AI video editor
        </Text>
      </View>
      {ios ? null : (
        <GlassGroup style={s.topActions}>
          <IconButton icon="list" label="All videos" onPress={openAllVideos} />
          <ActionMenu icon="plus" label="New" items={NEW_MENU} testID="new-menu" />
        </GlassGroup>
      )}
    </View>
  );
}

function Section({ title, entering, children }: { title: string; entering: ReturnType<typeof useLayoutMotion>['appear']; children: ReactNode }) {
  const s = useStyles();
  const m = useLayoutMotion();
  return (
    <Animated.View entering={entering} layout={m.listLayout} style={s.list}>
      <Text variant="secondary" weight={600} tone="muted" accessibilityRole="header" style={s.sectionLabel}>
        {title}
      </Text>
      {children}
    </Animated.View>
  );
}

/** A row that came in after the first load arrives with `listInsert`; the rest move with the layout. */
function ListRow({ insert, children }: { insert: boolean; children: ReactNode }) {
  const m = useLayoutMotion();
  return (
    <Animated.View entering={insert ? m.listInsert : undefined} exiting={m.listRemove} layout={m.listLayout}>
      {children}
    </Animated.View>
  );
}

function GoalCard({ goal }: { goal: GoalView }) {
  const s = useStyles();
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
      <View style={s.spread}>
        <Text variant="secondary" tone="muted">
          This week's goal
        </Text>
        <Text variant="secondary" tone="muted">
          {goal.streakWeeks > 0 ? `${plural(goal.streakWeeks, 'week')} streak` : 'Resets Monday'}
        </Text>
      </View>
      <Text variant="goal" tabular>
        {line}
      </Text>
      <StepBar done={goal.postedThisWeek} total={goal.videosPerWeek} accessibilityLabel={line} />
    </Card>
  );
}

/** A creation tile (96 high, radius 20): Upload clips is the screen's one gloss; Record is a content card. */
function Tile({ icon, label, onPress, primary }: { icon: IconName; label: string; onPress: () => void; primary?: boolean }) {
  const s = useStyles();
  const t = useTheme();
  return (
    <PressableScale onPress={onPress} motion="tile" haptic={primary ? 'light' : false} accessibilityRole="button" accessibilityLabel={label} style={[s.tile, primary ? t.shadow.gloss : [s.tileContent, t.shadow.surface]]}>
      {primary ? <LinearGradient colors={t.accentGloss.colors} locations={t.accentGloss.locations} style={[StyleSheet.absoluteFill, { borderRadius: radius.card }]} pointerEvents="none" /> : null}
      {/* Wrapped so the content stacks above the absolutely positioned gloss on web. */}
      <View>
        <SymbolIcon name={icon} size={22} strokeWidth={2.2} color={primary ? t.color.onAccent : t.color.ink} />
      </View>
      <Text variant="bodyLg" tone={primary ? 'white' : 'ink'}>
        {label}
      </Text>
    </PressableScale>
  );
}

function SeeAll({ label, onPress }: { label: string; onPress: () => void }) {
  const s = useStyles();
  const c = useColors();
  return (
    <PressableScale onPress={onPress} motion="row" accessibilityRole="button" accessibilityLabel={label} style={s.seeAll}>
      <Text variant="secondary" weight={600} tone="accent">
        {label}
      </Text>
      <SymbolIcon name="chevronRight" size={12} strokeWidth={2.4} color={c.accent} />
    </PressableScale>
  );
}

/** A batch stays on Home until every video in it is finished: uploading, editing, to review, exporting. */
function BatchCard({ batch }: { batch: BatchSummary }) {
  const s = useStyles();
  const st = batchCardState(batch);
  const title = `Batch of ${batch.total} ${st.phrase}`;
  return (
    <Card gap={10} onPress={() => router.push(`/batch/${batch.id}`)} accessibilityLabel={`${title}, ${st.done} done`} accessibilityHint="Shows each video's progress">
      <View style={s.spread}>
        <Text variant="body" weight={600} style={{ flexShrink: 1 }} numberOfLines={1}>
          {title}
        </Text>
        <Text variant="secondary" tone="muted" tabular>
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

const useStyles = makeStyles((t) => ({
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 },
  brand: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  topActions: { flexDirection: 'row', gap: 8 },
  seeAll: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44, alignSelf: 'flex-start' },
  spread: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  tile: { flex: 1, height: 96, borderRadius: radius.card, padding: 14, justifyContent: 'space-between' },
  tileContent: { backgroundColor: t.color.surface, borderWidth: 1, borderColor: t.color.hairline },
  list: { gap: 0 },
  sectionLabel: { paddingBottom: 4 },
}));

const styles = StyleSheet.create({
  tiles: { flexDirection: 'row', gap: 12 },
});
