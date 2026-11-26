import { Modal, StyleSheet, View } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconButton, Text, color } from '@/ui';

/** Full-screen player for a rendered file (preview with effects, an export version). */
export function VideoModal({ url, title, onClose }: { url: string | null; title: string; onClose: () => void }) {
  return (
    <Modal visible={!!url} animationType="slide" onRequestClose={onClose} presentationStyle="fullScreen">
      {url ? <Player url={url} title={title} onClose={onClose} /> : null}
    </Modal>
  );
}

function Player({ url, title, onClose }: { url: string; title: string; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const player = useVideoPlayer({ uri: url }, (p) => {
    p.loop = true;
    p.play();
  });
  return (
    <View style={[styles.root, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 8 }]}>
      <View style={styles.top}>
        <Text variant="body" weight={600} tone="white" style={{ flex: 1 }} numberOfLines={1}>
          {title}
        </Text>
        <View style={styles.close}>
          <IconButton icon="close" label="Close player" onPress={onClose} />
        </View>
      </View>
      <View style={styles.video}>
        <VideoView player={player} style={styles.fill} contentFit="contain" nativeControls />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.cameraScrim, paddingHorizontal: 16, gap: 12 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  close: { backgroundColor: 'rgba(255,255,255,0.9)', borderRadius: 22 },
  video: { flex: 1, borderRadius: 16, overflow: 'hidden' },
  fill: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' },
});
