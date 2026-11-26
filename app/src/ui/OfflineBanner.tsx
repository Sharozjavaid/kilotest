import { StyleSheet, View } from 'react-native';
import { useOnline } from '@/lib/network';
import { color, radius, space } from './tokens';
import { Text } from './type';
import { Icon } from './Icon';

/** Shown at the top of every screen while the device is offline. */
export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <View style={styles.banner} accessibilityRole="alert" accessibilityLiveRegion="polite">
      <Icon name="wifiOff" size={18} color={color.white} />
      <Text variant="secondary" weight={500} tone="white" style={styles.text}>
        You're offline. Uploads and edits resume when you reconnect.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginHorizontal: space.gutter,
    marginBottom: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.md,
    backgroundColor: color.ink,
  },
  text: { flex: 1 },
});
