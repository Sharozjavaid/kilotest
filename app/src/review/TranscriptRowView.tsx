import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { formatDuration } from '@/lib/format';
import { Icon } from '@/ui/Icon';
import { color, radius } from '@/ui/tokens';
import { Text } from '@/ui/type';
import type { TranscriptRow } from './rows';

/** A base overlay on this line, as the version being watched treats it. */
export interface RowOverlayItem {
  id: string;
  /** "B-roll", "Bold title". */
  label: string;
}

/** Overlays on the line in the version being watched (a variant): which it shows and which it leaves out. */
export interface RowOverlayInfo {
  variantLabel: string;
  shown: readonly RowOverlayItem[];
  hidden: readonly RowOverlayItem[];
}

/**
 * A transcript row. Kept: glass card with the accent bar. Cut: dashed outline,
 * struck-through muted text and, under it, why it was cut in plain words (a retake
 * offers "Keep both"). Tap toggles; the time seeks. While a variant is selected, a base
 * overlay it leaves out says so on its line, with "Show" to bring it back in that
 * version; one it shows can be hidden there from the marker.
 */
export const TranscriptRowView = memo(function TranscriptRowView({
  row,
  active,
  onToggle,
  onSeek,
  hasOverlay,
  why,
  onKeepBoth,
  overlays,
  onOverlayHidden,
}: {
  row: TranscriptRow;
  active: boolean;
  /** The line carries B-roll or a motion graphic in the version being watched. */
  hasOverlay?: boolean;
  onToggle: (segmentId: string) => void;
  onSeek: (row: TranscriptRow) => void;
  /** Why a cut row was cut ("Retake of the next line"). */
  why?: string | null;
  /** A cut retake: restore it and keep the take that replaced it too. */
  onKeepBoth?: (segmentId: string) => void;
  overlays?: RowOverlayInfo | null;
  onOverlayHidden?: (overlayId: string, hidden: boolean) => void;
}) {
  const time = formatDuration(row.proxyStart);
  const reason = row.keep ? null : (why ?? row.reasonLabel ?? 'Cut');
  const hidden = overlays?.hidden ?? [];
  const firstShown = overlays?.shown[0];
  const hiddenNote = hidden.length ? `. ${hidden.map((h) => h.label).join(' and ')} left out of ${overlays!.variantLabel}` : '';
  return (
    <Pressable
      onPress={() => onToggle(row.segmentId)}
      accessibilityRole="button"
      accessibilityLabel={`${row.text}. ${row.keep ? 'Kept' : `Cut: ${reason}`}${hasOverlay ? '. Has B-roll or a graphic' : ''}${hiddenNote}`}
      accessibilityHint={row.keep ? 'Cuts this line' : 'Puts this line back'}
      accessibilityState={{ selected: row.keep }}
      aria-pressed={row.keep}
      testID={`row-${row.segmentId}`}
      style={({ pressed }) => [styles.row, row.keep ? styles.kept : styles.cut, active && (row.keep ? styles.activeKept : styles.activeCut), pressed && styles.pressed]}
    >
      {row.keep ? <View style={styles.bar} /> : null}
      <View style={styles.body}>
        <Text variant="transcript" tone={row.keep && !row.isSilence ? 'ink' : 'muted'} strike={!row.keep} style={row.isSilence && styles.silence}>
          {row.text}
        </Text>
        {reason && !row.isSilence ? (
          <View style={styles.subline}>
            <Text variant="label" weight={600} tone="cut" testID={`why-${row.segmentId}`}>
              {reason}
            </Text>
            {onKeepBoth ? (
              <Pressable
                onPress={() => onKeepBoth(row.segmentId)}
                accessibilityRole="button"
                accessibilityLabel={`Keep both takes: put “${row.text}” back as well`}
                hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
                style={styles.inlineButton}
                testID={`keep-both-${row.segmentId}`}
              >
                <Text variant="label" weight={600} tone="accent">
                  Keep both
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {hidden.map((h) => (
          <View key={h.id} style={styles.subline} testID={`hidden-overlay-${h.id}`}>
            <Text variant="label" tone="muted">
              {h.label} left out of {overlays!.variantLabel}
            </Text>
            {onOverlayHidden ? (
              <Pressable
                onPress={() => onOverlayHidden(h.id, false)}
                accessibilityRole="button"
                accessibilityLabel={`Show ${h.label} in ${overlays!.variantLabel}`}
                hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
                style={styles.inlineButton}
                testID={`overlay-show-${h.id}`}
              >
                <Text variant="label" weight={600} tone="accent">
                  Show
                </Text>
              </Pressable>
            ) : null}
          </View>
        ))}
      </View>
      {firstShown && onOverlayHidden && overlays ? (
        <Pressable
          onPress={() => onOverlayHidden(firstShown.id, true)}
          accessibilityRole="button"
          accessibilityLabel={`${firstShown.label} on this line. Leave it out of ${overlays.variantLabel}`}
          hitSlop={{ top: 12, bottom: 12, left: 8, right: 4 }}
          style={styles.mark}
          testID={`overlay-hide-${firstShown.id}`}
        >
          <View testID={`overlay-mark-${row.segmentId}`}>
            <Icon name="broll" size={15} color={row.keep ? color.accent : color.muted} />
          </View>
        </Pressable>
      ) : hasOverlay ? (
        <View testID={`overlay-mark-${row.segmentId}`}>
          <Icon name="broll" size={15} color={row.keep ? color.accent : color.muted} />
        </View>
      ) : null}
      {reason && row.isSilence ? (
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
  body: { flex: 1, gap: 2 },
  subline: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  inlineButton: { minHeight: 24, justifyContent: 'center' },
  silence: { fontStyle: 'italic' },
  mark: { minWidth: 28, minHeight: 32, alignItems: 'center', justifyContent: 'center' },
  time: { minWidth: 32, minHeight: 28, alignItems: 'flex-end', justifyContent: 'center' },
});
