import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform, RefreshControl, ScrollView, TextInput, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { FlashList } from '@shopify/flash-list';
import { router, useLocalSearchParams } from 'expo-router';
import { libraryRows, useLibrary, type LibraryFilter } from '@/api/queries';
import { VideoRow } from '@/components/VideoRow';
import { HEADER_HEIGHT, LIBRARY_FILTERS, batchHeading, libraryEmpty, libraryHref, libraryItems, librarySubtitle, type LibraryItem } from '@/library/items';
import { Chip, EmptyState, ErrorState, PillButton, PressableScale, Screen, SkeletonRows, SymbolIcon, Text, makeStyles, size, space, typeStyle, useColors } from '@/ui';

const ios = Platform.OS === 'ios';
const native = Platform.OS !== 'web';

/** The rows' opacity, shared by every visible row: a filter change cross-fades the list (150 ms) on the UI thread. */
const FadeContext = createContext<SharedValue<number> | null>(null);

/**
 * All videos (design brief 4.3): every video the creator has, a page at a time, newest batch
 * first and each batch in its own order, with filter chips and search by title (the native
 * search field in the bar on iOS). A FlashList of fixed 76pt rows with remembered thumbnails and
 * no polling, so several hundred videos scroll smoothly.
 */
export default function LibraryScreen() {
  const s = useStyles();
  const c = useColors();
  const params = useLocalSearchParams<{ filter?: string }>();
  const [filter, setFilter] = useState<LibraryFilter>(() => (LIBRARY_FILTERS.some((f) => f.value === params.filter) ? (params.filter as LibraryFilter) : 'all'));
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  // Search after a short pause in typing, not on every key.
  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 300);
    return () => clearTimeout(t);
  }, [typed]);

  const lib = useLibrary(filter, q);
  const videos = useMemo(() => libraryRows(lib.data?.pages), [lib.data]);
  const items = useMemo(() => libraryItems(videos), [videos]);

  // Cross-fade the rows when the filter or the search changes, and when its first page lands.
  const fade = useSharedValue(1);
  const hasData = !!lib.data;
  useEffect(() => {
    if (!native) return;
    fade.value = 0;
    fade.value = withTiming(1, { duration: 150 });
  }, [filter, q, hasData, fade]);

  // A thumbnail link expired with no newer one: refetch the pages, at most every half minute.
  const lastStale = useRef(0);
  const refetch = lib.refetch;
  const onThumbStale = useCallback(() => {
    if (Date.now() - lastStale.current < 30_000) return;
    lastStale.current = Date.now();
    void refetch();
  }, [refetch]);

  const renderItem = useCallback(({ item }: { item: LibraryItem }) => <LibraryCell item={item} onThumbStale={onThumbStale} />, [onThumbStale]);

  const empty = libraryEmpty(filter, q);
  const chips = useMemo(
    () => (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips} style={s.chipsRow} accessibilityLabel="Show">
        {LIBRARY_FILTERS.map((f) => (
          <Chip key={f.value} label={f.label} selected={f.value === filter} onPress={() => setFilter(f.value)} testID={`library-filter-${f.value}`} />
        ))}
      </ScrollView>
    ),
    [filter, s],
  );

  const listEmpty = lib.isPending ? (
    <SkeletonRows count={8} />
  ) : lib.isError ? (
    <ErrorState error={lib.error} onRetry={() => void lib.refetch()} />
  ) : (
    <View style={{ gap: 4 }}>
      <EmptyState icon="videos" title={empty.title} body={empty.body} />
      {empty.showAll ? <PillButton variant="text" label="Show all" onPress={() => setFilter('all')} /> : null}
    </View>
  );

  return (
    <Screen
      appearance="auto"
      scroll={false}
      gap={12}
      testID="library"
      // iOS: the list is the screen's scroll view, under the bar and its search field (automatic insets).
      contentStyle={ios ? { paddingTop: 0, paddingBottom: 0, paddingHorizontal: 0 } : undefined}
      header={{
        title: 'All videos',
        meta: videos.length ? `${videos.length}${lib.hasNextPage ? '+' : ''}` : undefined,
        search: { placeholder: 'Search by title', onChangeText: setTyped },
      }}
    >
      {ios ? null : (
        <View style={s.search}>
          <SymbolIcon name="search" size={18} color={c.muted} />
          <TextInput
            value={typed}
            onChangeText={setTyped}
            placeholder="Search by title"
            placeholderTextColor={c.muted}
            accessibilityLabel="Search videos by title"
            autoCorrect={false}
            returnKeyType="search"
            style={s.searchInput}
            testID="library-search"
          />
          {typed ? (
            <PressableScale onPress={() => setTyped('')} motion="icon" accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={8} style={s.clear}>
              <SymbolIcon name="close" size={14} color={c.muted} />
            </PressableScale>
          ) : null}
        </View>
      )}
      <FadeContext.Provider value={native ? fade : null}>
        <FlashList
          data={items}
          keyExtractor={(it) => it.key}
          getItemType={(it) => it.kind}
          renderItem={renderItem}
          ListHeaderComponent={chips}
          ListEmptyComponent={listEmpty}
          onEndReached={() => {
            if (lib.hasNextPage && !lib.isFetchingNextPage) void lib.fetchNextPage();
          }}
          onEndReachedThreshold={0.6}
          contentInsetAdjustmentBehavior={ios ? 'automatic' : undefined}
          contentContainerStyle={ios ? s.listContentIos : s.listContent}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          style={s.list}
          refreshControl={<RefreshControl refreshing={lib.isRefetching && !lib.isFetchingNextPage} onRefresh={() => void lib.refetch()} tintColor={c.accent} />}
          ListFooterComponent={
            lib.isFetchingNextPage ? (
              // The next page: one row skeleton. The end of the list says nothing.
              <SkeletonRows count={1} />
            ) : lib.isError && videos.length ? (
              <PressableScale onPress={() => void lib.fetchNextPage()} motion="row" accessibilityRole="button" style={s.footer}>
                <Text variant="secondary" tone="cut" center>
                  Couldn't load more. Tap to try again.
                </Text>
              </PressableScale>
            ) : null
          }
          testID="library-list"
        />
      </FadeContext.Provider>
    </Screen>
  );
}

function LibraryCell({ item, onThumbStale }: { item: LibraryItem; onThumbStale: () => void }) {
  if (item.kind === 'batch') return <BatchHeading batchId={item.batchId} createdAt={item.createdAt} />;
  return (
    <FadeRow>
      <VideoRow video={item.video} subtitle={librarySubtitle(item.video)} onPress={() => router.push(libraryHref(item.video))} onThumbStale={onThumbStale} />
    </FadeRow>
  );
}

function FadeRow({ children }: { children: ReactNode }) {
  const fade = useContext(FadeContext);
  if (!fade) return <>{children}</>;
  return <FadeRowNative fade={fade}>{children}</FadeRowNative>;
}

function FadeRowNative({ fade, children }: { fade: SharedValue<number>; children: ReactNode }) {
  const style = useAnimatedStyle(() => ({ opacity: fade.value }));
  return <Animated.View style={style}>{children}</Animated.View>;
}

function BatchHeading({ batchId, createdAt }: { batchId: string; createdAt: string }) {
  const s = useStyles();
  const c = useColors();
  const label = batchHeading(createdAt);
  return (
    <PressableScale
      onPress={() => router.push(`/batch/${batchId}`)}
      motion="row"
      accessibilityRole="button"
      accessibilityLabel={`${label}. Open the batch`}
      style={s.batchHeader}
      testID={`library-batch-${batchId}`}
    >
      <Text variant="label" weight={600} tone="muted" style={s.batchText} numberOfLines={1}>
        {label.toUpperCase()}
      </Text>
      <SymbolIcon name="chevronRight" size={11} strokeWidth={2.4} color={c.muted} />
    </PressableScale>
  );
}

const useStyles = makeStyles((t) => ({
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: size.touch,
    paddingHorizontal: 14,
    borderRadius: size.touch / 2,
    borderWidth: 1,
    borderColor: t.color.hairline,
    backgroundColor: t.color.surfaceStrong,
  },
  searchInput: { ...typeStyle('body'), color: t.color.ink, flex: 1, height: size.touch, paddingVertical: 0 },
  clear: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  chipsRow: { marginHorizontal: -space.gutter, marginBottom: 4 },
  chips: { gap: 8, paddingHorizontal: space.gutter, paddingVertical: 6 },
  list: { flex: 1, minHeight: 0 },
  listContent: { paddingBottom: space.gutter },
  listContentIos: { paddingHorizontal: space.gutter, paddingBottom: space.gutter },
  batchHeader: { height: HEADER_HEIGHT, flexDirection: 'row', alignItems: 'flex-end', gap: 4, paddingBottom: 8 },
  batchText: { letterSpacing: 0.6 },
  footer: { paddingVertical: 16 },
}));
