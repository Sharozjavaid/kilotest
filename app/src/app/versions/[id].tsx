import { useMemo, type ReactNode } from 'react';
import { Platform, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { router, useLocalSearchParams } from 'expo-router';
import type { ListEdlVersionsResponse } from '@kilo/edl';
import { useEdlVersions } from '@/api/queries';
import { SheetHeader } from '@/components/SheetHeader';
import { compareTargetFor, versionRows, type VersionRowModel } from '@/review/versions';
import { Card, Chip, ErrorState, PressableScale, Screen, SkeletonRows, SymbolIcon, Text, makeStyles, useColors, useLayoutMotion, type ScreenProps } from '@/ui';

const ios = Platform.OS === 'ios';

const close = () => (router.canGoBack() ? router.back() : router.replace('/'));

const useStyles = makeStyles((t) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 16, minHeight: 64 },
  divider: { height: 1, backgroundColor: t.color.hairline, marginLeft: 16 },
  main: { flex: 1, gap: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  side: { alignItems: 'flex-end', gap: 2 },
}));

/**
 * The frame: iOS a form sheet over Review (medium and large detents) on the system glass, with
 * its own title row and a glass close (brief 5.9). Elsewhere a pushed screen with the usual header.
 */
function Frame({ children, ...props }: Omit<ScreenProps, 'appearance' | 'header' | 'sheet' | 'ground'> & { children: ReactNode }) {
  return (
    <Screen appearance="auto" sheet ground="none" header={ios ? undefined : { title: 'Versions' }} {...props}>
      {ios ? <SheetHeader title="Versions" onClose={close} /> : null}
      {children}
    </Screen>
  );
}

/**
 * Every saved version of a video's edit, newest first (GET /v1/videos/:id/edl/versions). Opened
 * from Review's menu. Tapping one compares it with the current edit. Param `id` is the video id;
 * `variant` the opening Review was showing, passed on to Compare.
 */
export default function VersionsScreen() {
  const { id, variant } = useLocalSearchParams<{ id: string; variant?: string }>();
  const versions = useEdlVersions(id);

  if (versions.isPending) {
    return (
      <Frame>
        <SkeletonRows count={4} />
      </Frame>
    );
  }
  if (!versions.data) {
    return (
      <Frame>
        <ErrorState error={versions.error} onRetry={() => void versions.refetch()} />
      </Frame>
    );
  }
  return <VersionList videoId={id} variant={variant} list={versions.data} refreshing={versions.isRefetching} onRefresh={() => void versions.refetch()} />;
}

function VersionList({ videoId, variant, list, refreshing, onRefresh }: { videoId: string; variant?: string; list: ListEdlVersionsResponse; refreshing: boolean; onRefresh: () => void }) {
  const s = useStyles();
  const m = useLayoutMotion();
  // Recomputed with the list; "4 min ago" is as fresh as the last fetch, which is fine for a sheet.
  const rows = useMemo(() => versionRows(list), [list]);
  const open = (revision: number) => {
    const target = compareTargetFor(revision, list);
    if (!target) return;
    const q = new URLSearchParams({ rev: String(target.rev), vs: String(target.vs) });
    if (variant) q.set('variant', variant);
    router.push(`/compare/${videoId}?${q.toString()}`);
  };
  const only = rows.length === 1;
  return (
    <Frame refreshing={refreshing} onRefresh={onRefresh} gap={12}>
      <Text variant="secondary" tone="muted">
        {only ? 'Kilo keeps every version of this edit. Your changes will show up here.' : 'Kilo keeps every version of this edit. Tap one to compare it with the current edit.'}
      </Text>
      <Card padding={0} testID="version-list">
        {rows.map((r, i) => (
          <Animated.View key={r.revision} entering={m.appearAt(i)}>
            {i > 0 ? <View style={s.divider} /> : null}
            <VersionRow row={r} disabled={only} onPress={() => open(r.revision)} />
          </Animated.View>
        ))}
      </Card>
    </Frame>
  );
}

function VersionRow({ row, disabled, onPress }: { row: VersionRowModel; disabled: boolean; onPress: () => void }) {
  const s = useStyles();
  const c = useColors();
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      motion="row"
      pressedBackgroundColor={c.pressedRow}
      accessibilityRole="button"
      accessibilityLabel={row.label}
      accessibilityHint={disabled ? undefined : row.current ? 'Compares it with the version before' : 'Compares it with the current edit'}
      testID={`version-row-${row.revision}`}
      style={s.row}
    >
      <View style={s.main}>
        <View style={s.titleRow}>
          <Text variant="bodyLg" weight={600} tabular>
            {row.title}
          </Text>
          {row.current ? <Chip kind="status" label="Current" testID="version-current" /> : null}
        </View>
        <Text variant="secondary" tone="muted" numberOfLines={1}>
          {`${row.who} · ${row.when}`}
        </Text>
        <Text variant="secondary" numberOfLines={2}>
          {row.summary}
        </Text>
      </View>
      <View style={s.side}>
        <Text variant="secondary" tone="muted" tabular>
          {row.duration}
        </Text>
      </View>
      {disabled ? null : <SymbolIcon name="chevronRight" size={14} color={c.muted} />}
    </PressableScale>
  );
}
