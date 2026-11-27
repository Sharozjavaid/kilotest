import { memo, type ReactNode } from 'react';
import { Platform, View } from 'react-native';
import type { VideoSummary } from '@kilo/edl';
import { PressableScale } from '@/ui/PressableScale';
import { SymbolIcon } from '@/ui/SymbolIcon';
import { Text } from '@/ui/type';
import { Thumb } from '@/ui/Thumb';
import { makeStyles, useColors } from '@/ui/theme';

import { VIDEO_ROW_HEIGHT } from './sizes';

export { VIDEO_ROW_HEIGHT };
/** 9:16 at the row's height (the brief's 44 x 78 does not fit a 76 row). */
const THUMB_W = 36;
const THUMB_H = 64;
/** The row bleeds 12 into the gutter so the pressed background has room. */
const PAD = 12;

const useStyles = makeStyles((t) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, height: VIDEO_ROW_HEIGHT, paddingHorizontal: PAD, marginHorizontal: -PAD, borderRadius: 14 },
  divider: { position: 'absolute', top: 0, right: PAD, left: PAD + THUMB_W + 12, height: 1, backgroundColor: t.color.hairline },
  text: { flex: 1, gap: 3 },
}));

/**
 * A video in a list (design brief 5.8): 9:16 thumb, title (15/500, one line), muted line (13,
 * one line), and on the right a status (chip, ring, failed icon) and a chevron when it opens
 * something. 76 high. Pressed: the row background at once, then the `press` scale.
 *
 * Its accessible name is "Title, line", which the browser suite matches.
 */
export const VideoRow = memo(function VideoRow({
  video,
  subtitle,
  onPress,
  divider,
  right,
  onThumbStale,
  testID,
}: {
  video: Pick<VideoSummary, 'id' | 'title' | 'thumbnailUrl'>;
  subtitle: string;
  onPress?: () => void;
  divider?: boolean;
  right?: ReactNode;
  /** The thumbnail link expired and the row has no newer one. */
  onThumbStale?: () => void;
  testID?: string;
}) {
  const s = useStyles();
  const c = useColors();
  return (
    <PressableScale
      onPress={onPress}
      disabled={!onPress}
      motion="row"
      pressedBackgroundColor={onPress ? c.pressedRow : undefined}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={`${video.title}, ${subtitle}`}
      testID={testID}
      style={s.row}
    >
      {divider ? <View style={s.divider} /> : null}
      <Thumb uri={video.thumbnailUrl} cacheKey={video.id} onStale={onThumbStale} width={THUMB_W} height={THUMB_H} r={8} />
      <View style={s.text}>
        <Text variant="body" weight={500} numberOfLines={1}>
          {video.title}
        </Text>
        <Text variant="secondary" tone="muted" numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
      {right}
      {onPress ? <SymbolIcon name="chevronRight" size={Platform.OS === 'ios' ? 14 : 16} strokeWidth={2.2} color={c.muted} /> : null}
    </PressableScale>
  );
});
