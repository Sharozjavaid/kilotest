import { useEffect } from 'react';
import { Modal, StyleSheet, View } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconButton, Text, ThemeScope, color } from '@/ui';

/**
 * Full-screen player for a rendered file (preview with effects, an export version). Always dark,
 * whatever the appearance: a video plays on the player ground with one small glass close button.
 */
export function VideoModal({ url, title, onClose }: { url: string | null; title: string; onClose: () => void }) {
  return (
    <Modal visible={!!url} animationType="slide" onRequestClose={onClose} presentationStyle="fullScreen">
      {url ? (
        <ThemeScope appearance="dark">
          <Player url={url} title={title} onClose={onClose} />
        </ThemeScope>
      ) : null}
    </Modal>
  );
}

function Player({ url, title, onClose }: { url: string; title: string; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const player = useVideoPlayer({ uri: url }, (p) => {
    p.loop = true;
  });
  // Start once the view is mounted: on web the player plays through its <video> elements,
  // and a play() in the setup callback (before any is attached) does nothing.
  useEffect(() => {
    player.play();
  }, [player]);
  return (
    <View style={[styles.root, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 8 }]}>
      <View style={styles.top}>
        <Text variant="body" weight={600} tone="white" style={{ flex: 1 }} numberOfLines={1}>
          {title}
        </Text>
        <IconButton icon="close" label="Close player" onPress={onClose} />
      </View>
      <View style={styles.video}>
        <VideoView player={player} style={styles.fill} contentFit="contain" nativeControls />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.player, paddingHorizontal: 16, gap: 12 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  video: { flex: 1, borderRadius: 16, overflow: 'hidden' },
  fill: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' },
});
