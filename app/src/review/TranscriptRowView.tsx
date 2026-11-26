import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { formatDuration } from '@/lib/format';
import { Icon } from '@/ui/Icon';
import { color, radius } from '@/ui/tokens';
import { Text } from '@/ui/type';
import type { TranscriptRow } from './rows';

/**
 * A transcript row. Kept: glass card with the accent bar. Cut: dashed outline,
 * struck-through muted text and the reason label. Tap toggles; the time seeks.
 */
export const TranscriptRowView = memo(function TranscriptRowView({
  row,
  active,
  onToggle,
  onSeek,
  hasOverlay,
}: {
  row: TranscriptRow;
  active: boolean;
  /** The line carries B-roll or a motion graphic. */
  hasOverlay?: boolean;
  onToggle: (segmentId: string) => void;
  onSeek: (row: TranscriptRow) => void;
}) {
  const time = formatDuration(row.proxyStart);
  return (
    <Pressable
      onPress={() => onToggle(row.segmentId)}
      accessibilityRole="button"
      accessibilityLabel={`${row.text}. ${row.keep ? 'Kept' : `Cut: ${row.reasonLabel ?? 'cut'}`}${hasOverlay ? '. Has B-roll or a graphic' : ''}`}
      accessibilityHint={row.keep ? 'Cuts this line' : 'Puts this line back'}
      accessibilityState={{ selected: row.keep }}
      aria-pressed={row.keep}
      testID={`row-${row.segmentId}`}
      style={({ pressed }) => [styles.row, row.keep ? styles.kept : styles.cut, active && (row.keep ? styles.activeKept : styles.activeCut), pressed && styles.pressed]}
    >
      {row.keep ? <View style={styles.bar} /> : null}
      <Text
        variant="transcript"
        tone={row.keep && !row.isSilence ? 'ink' : 'muted'}
        strike={!row.keep}
        style={[styles.text, row.isSilence && styles.silence]}
      >
        {row.text}
      </Text>
      {hasOverlay ? (
        <View testID={`overlay-mark-${row.segmentId}`}>
          <Icon name="broll" size={15} color={row.keep ? color.accent : color.muted} />
        </View>
      ) : null}
      {!row.keep && row.reasonLabel ? (
        <Text variant="label" weight={600} tone="cut">
          {row.reasonLabel}
        </Text>
      ) : null}
      <Pressable
        onPress={() => onSeek(row)}
        accessibilityRole="button"
        accessibilityLabel={`Play from ${time}`}
        hitSlop={{ top: 12, bottom: 12, left: 6, right: 8 }}
        style={styles.time}
        testID={`seek-${row.segmentId}`}
      >
        <Text variant="label" tone={active ? 'accent' : 'muted'} weight={active ? 600 : 400}>
          {time}
        </Text>
      </Pressable>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: {
    minHeight: 48,
    borderRadius: radius.row,
    paddingVertical: 8,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  kept: { borderWidth: 1, borderColor: color.hairline, backgroundColor: color.surfaceStrong },
  cut: { borderWidth: 1, borderStyle: 'dashed', borderColor: color.cutRowBorder, backgroundColor: 'transparent' },
  activeKept: { borderColor: color.accent, backgroundColor: color.white },
  activeCut: { borderColor: color.cut },
  pressed: { opacity: 0.7 },
  bar: { width: 4, alignSelf: 'stretch', borderRadius: 2, backgroundColor: color.accent },
  text: { flex: 1 },
  silence: { fontStyle: 'italic' },
  time: { minWidth: 32, minHeight: 28, alignItems: 'flex-end', justifyContent: 'center' },
});
