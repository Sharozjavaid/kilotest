import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { VideoSummary } from '@kilo/edl';
import { color } from '@/ui/tokens';
import { Icon } from '@/ui/Icon';
import { Text } from '@/ui/type';
import { Thumb } from '@/ui/Thumb';

/** A list row from the mock-up's "Ready to review": 40x56 thumb, title, muted line, chevron. */
export const VideoRow = memo(function VideoRow({
  video,
  subtitle,
  onPress,
  divider,
  right,
  onThumbStale,
}: {
  video: Pick<VideoSummary, 'id' | 'title' | 'thumbnailUrl'>;
  subtitle: string;
  onPress?: () => void;
  divider?: boolean;
  right?: React.ReactNode;
  /** The thumbnail link expired and the row has no newer one. */
  onThumbStale?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={`${video.title}, ${subtitle}`}
      style={({ pressed }) => [styles.row, divider && styles.divider, pressed && styles.pressed]}
    >
      <Thumb uri={video.thumbnailUrl} cacheKey={video.id} onStale={onThumbStale} />
      <View style={styles.text}>
        <Text variant="body" weight={500} numberOfLines={1}>
          {video.title}
        </Text>
        <Text variant="secondary" tone="muted" numberOfLines={2}>
          {subtitle}
        </Text>
      </View>
      {right}
      {onPress ? <Icon name="chevronRight" size={18} color={color.muted} /> : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, paddingVertical: 4 },
  divider: { borderTopWidth: 1, borderTopColor: color.hairline },
  text: { flex: 1, gap: 3 },
  pressed: { opacity: 0.6 },
});
