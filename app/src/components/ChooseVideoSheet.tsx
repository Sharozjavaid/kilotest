import { useEffect } from 'react';
import { ActionSheetIOS, Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import type { DraftVideo } from '@/newBatch/grouping';
import { plural } from '@/lib/format';
import { Card, PillButton, Row, Text, makeStyles, useTheme } from '@/ui';

const TITLE = 'Add B-roll to which video?';
const MESSAGE = 'Kilo places B-roll against what is said in that video.';

/**
 * "Which video is this B-roll for?". iOS: the native action sheet (glass on iOS 26). Android
 * and web: a bottom sheet card over a scrim.
 */
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
  if (Platform.OS === 'ios') return <NativeChooser visible={visible} videos={videos} onChoose={onChoose} onClose={onClose} />;
  return <SheetChooser visible={visible} videos={videos} onChoose={onChoose} onClose={onClose} />;
}

function NativeChooser({ visible, videos, onChoose, onClose }: { visible: boolean; videos: DraftVideo[]; onChoose: (k: string) => void; onClose: () => void }) {
  useEffect(() => {
    if (!visible) return;
    const options = [...videos.map((v) => `${v.title} (${plural(v.broll.length, 'shot')})`), 'Cancel'];
    ActionSheetIOS.showActionSheetWithOptions({ title: TITLE, message: MESSAGE, options, cancelButtonIndex: options.length - 1 }, (i) => {
      const v = videos[i];
      if (v) onChoose(v.key);
      else onClose();
    });
    // Shown once per opening; the videos cannot change while it is up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);
  return null;
}

const useStyles = makeStyles((t) => ({
  sheet: { position: 'absolute', left: 12, right: 12, bottom: 24, maxHeight: '80%', backgroundColor: t.color.ground, borderRadius: 28 },
}));

function SheetChooser({ visible, videos, onChoose, onClose }: { visible: boolean; videos: DraftVideo[]; onChoose: (k: string) => void; onClose: () => void }) {
  const s = useStyles();
  const t = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: t.scheme === 'dark' ? 'rgba(0,0,0,0.5)' : 'rgba(11,18,32,0.32)' }]} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
      <View style={s.sheet}>
        <Card gap={4}>
          <Text variant="bodyLg" accessibilityRole="header">
            {TITLE}
          </Text>
          <Text variant="secondary" tone="muted">
            {MESSAGE}
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
