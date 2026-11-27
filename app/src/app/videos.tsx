import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { libraryRows, useLibrary, type LibraryFilter } from '@/api/queries';
import { VideoRow } from '@/components/VideoRow';
import { HEADER_HEIGHT, ROW_HEIGHT, batchHeading, itemLayouts, libraryHref, libraryItems, librarySubtitle, type LibraryItem } from '@/library/items';
import { EmptyState, ErrorState, Header, Icon, Screen, SkeletonRows, Text, color, radius, size, space, typeStyle } from '@/ui';

const FILTERS: { value: LibraryFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'review', label: 'To review' },
  { value: 'progress', label: 'Editing' },
  { value: 'finished', label: 'Finished' },
  { value: 'failed', label: "Couldn't edit" },
];

/**
 * All videos: every video the creator has, a page at a time, newest batch first and each
 * batch in its own order, with a status filter and search by title. A virtualised list
 * with fixed row heights, remembered thumbnails, and no polling, so several hundred videos
 * scroll smoothly. Reached from Home.
 */
export default function LibraryScreen() {
  const params = useLocalSearchParams<{ filter?: string }>();
  const [filter, setFilter] = useState<LibraryFilter>(() => (FILTERS.some((f) => f.value === params.filter) ? (params.filter as LibraryFilter) : 'all'));
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
  const layouts = useMemo(() => itemLayouts(items), [items]);

  // A thumbnail link expired with no newer one: refetch the pages, at most every half minute.
  const lastStale = useRef(0);
  const onThumbStale = useCallback(() => {
    if (Date.now() - lastStale.current < 30_000) return;
    lastStale.current = Date.now();
    void lib.refetch();
  }, [lib]);

  const renderItem = useCallback(
    ({ item }: { item: LibraryItem }) =>
      item.kind === 'batch' ? (
        <Pressable
          onPress={() => router.push(`/batch/${item.batchId}`)}
          accessibilityRole="button"
          accessibilityLabel={`${batchHeading(item.createdAt)}. Open the batch`}
          style={({ pressed }) => [styles.batchHeader, pressed && { opacity: 0.6 }]}
          testID={`library-batch-${item.batchId}`}
        >
          <Text variant="label" weight={600} tone="muted" style={styles.batchText} numberOfLines={1}>
            {batchHeading(item.createdAt).toUpperCase()}
          </Text>
          <Icon name="chevronRight" size={14} color={color.muted} />
        </Pressable>
      ) : (
        <View style={styles.rowWrap}>
          <VideoRow video={item.video} subtitle={librarySubtitle(item.video)} onPress={() => router.push(libraryHref(item.video))} onThumbStale={onThumbStale} />
        </View>
      ),
    [onThumbStale],
  );

  const empty = !lib.isPending && !lib.isError && videos.length === 0;

  return (
    <Screen scroll={false} gap={12} testID="library">
      <Header title="All videos" meta={videos.length ? `${videos.length}${lib.hasNextPage ? '+' : ''}` : undefined} />
      <View style={styles.search}>
        <Icon name="search" size={18} color={color.muted} />
        <TextInput
          value={typed}
          onChangeText={setTyped}
          placeholder="Search by title"
          placeholderTextColor={color.muted}
          accessibilityLabel="Search videos by title"
          autoCorrect={false}
          returnKeyType="search"
          style={styles.searchInput}
          testID="library-search"
        />
        {typed ? (
          <Pressable onPress={() => setTyped('')} accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={8} style={styles.clear}>
            <Icon name="close" size={16} color={color.muted} />
          </Pressable>
        ) : null}
      </View>
      <View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} accessibilityRole="radiogroup" accessibilityLabel="Show">
          {FILTERS.map((f) => {
            const on = f.value === filter;
            return (
              <Pressable
                key={f.value}
                onPress={() => setFilter(f.value)}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                aria-checked={on}
                accessibilityLabel={f.label}
                style={[styles.chip, on && styles.chipOn]}
                testID={`library-filter-${f.value}`}
              >
                <Text variant="secondary" weight={on ? 600 : 500} tone={on ? 'white' : 'ink'}>
                  {f.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {lib.isPending ? (
        <SkeletonRows count={6} />
      ) : lib.isError && !videos.length ? (
        <ErrorState error={lib.error} onRetry={() => void lib.refetch()} />
      ) : empty ? (
        <EmptyState
          icon="videos"
          title={q ? 'Nothing with that title' : 'No videos here'}
          body={q ? 'Try fewer or different words.' : filter === 'all' ? 'Videos you edit show up here.' : 'Try another filter.'}
        />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(it) => it.key}
          renderItem={renderItem}
          getItemLayout={(_, index) => layouts[index] ?? { length: ROW_HEIGHT, offset: 0, index }}
          onEndReached={() => {
            if (lib.hasNextPage && !lib.isFetchingNextPage) void lib.fetchNextPage();
          }}
          onEndReachedThreshold={0.6}
          initialNumToRender={14}
          maxToRenderPerBatch={14}
          windowSize={7}
          removeClippedSubviews
          style={styles.list}
          refreshControl={<RefreshControl refreshing={lib.isRefetching && !lib.isFetchingNextPage} onRefresh={() => void lib.refetch()} tintColor={color.accent} />}
          ListFooterComponent={
            lib.isFetchingNextPage ? (
              <Text variant="secondary" tone="muted" center style={styles.footer}>
                Loading more…
              </Text>
            ) : lib.isError ? (
              <Pressable onPress={() => void lib.fetchNextPage()} accessibilityRole="button" style={styles.footer}>
                <Text variant="secondary" tone="cut" center>
                  Couldn't load more. Tap to try again.
                </Text>
              </Pressable>
            ) : undefined
          }
          testID="library-list"
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: size.touch,
    paddingHorizontal: 14,
    borderRadius: size.touch / 2,
    borderWidth: 1,
    borderColor: color.hairline,
    backgroundColor: color.surfaceStrong,
  },
  searchInput: { ...typeStyle('body'), color: color.ink, flex: 1, height: size.touch, paddingVertical: 0 },
  clear: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  chips: { gap: 8 },
  chip: {
    height: size.touch,
    paddingHorizontal: 16,
    borderRadius: size.touch / 2,
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: color.hairline,
    backgroundColor: color.white,
  },
  chipOn: { backgroundColor: color.ink, borderColor: color.ink },
  list: { flex: 1, minHeight: 0, marginHorizontal: -space.xs },
  batchHeader: { height: HEADER_HEIGHT, flexDirection: 'row', alignItems: 'flex-end', gap: 4, paddingBottom: 8, paddingHorizontal: space.xs },
  batchText: { letterSpacing: 0.6 },
  rowWrap: { height: ROW_HEIGHT, justifyContent: 'center', paddingHorizontal: space.xs, borderRadius: radius.md },
  footer: { paddingVertical: 16 },
});
