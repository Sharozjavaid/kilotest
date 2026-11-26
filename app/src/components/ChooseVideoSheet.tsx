import { Modal, Pressable, StyleSheet, View } from 'react-native';
import type { DraftVideo } from '@/newBatch/grouping';
import { plural } from '@/lib/format';
import { Card, PillButton, Row, Text, color } from '@/ui';

/** "Which video is this B-roll for?" bottom sheet. */
export function ChooseVideoSheet({
  visible,
  videos,
  onChoose,
  onClose,
}: {
  visible: boolean;
  videos: DraftVideo[];
  onChoose: (videoKey: string) => void;
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
      <View style={styles.sheet}>
        <Card gap={4}>
          <Text variant="bodyLg" accessibilityRole="header">
            Add B-roll to which video?
          </Text>
          <Text variant="secondary" tone="muted">
            Kilo places B-roll against what is said in that video.
          </Text>
          {videos.map((v, i) => (
            <Row key={v.key} divider={i > 0} title={v.title} subtitle={plural(v.broll.length, 'B-roll shot') + ' so far'} onPress={() => onChoose(v.key)} chevron />
          ))}
          <PillButton variant="text" label="Cancel" onPress={onClose} />
        </Card>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(11,18,32,0.35)' },
  sheet: { position: 'absolute', left: 12, right: 12, bottom: 24, maxHeight: '80%', backgroundColor: color.ground, borderRadius: 22 },
});
