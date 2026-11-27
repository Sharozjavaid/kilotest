import { View, type StyleProp, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { useStableUrl } from '@/lib/stableUrl';
import { color, radius } from './tokens';

/**
 * Thumbnail with the track-colour placeholder of the mock-up (40 x 56 by default).
 *
 * Lists poll while videos move, and every response signs the thumbnail link afresh. Handing each
 * new link to the image reloads it on every poll (on web expo-image also keeps a node per source
 * it has seen until the newest one loads: thousands of <img> over a 30-video batch), so the first
 * link is kept until it fails, which is what an expired link looks like.
 */
export function Thumb({ uri, width = 40, height = 56, r = radius.sm, style }: { uri?: string | null; width?: number; height?: number; r?: number; style?: StyleProp<ViewStyle> }) {
  const stable = useStableUrl(uri ?? null);
  return (
    <View style={[{ width, height, borderRadius: r, backgroundColor: color.track, overflow: 'hidden', flexShrink: 0 }, style]}>
      {stable.url ? <Image source={{ uri: stable.url }} style={{ width, height }} contentFit="cover" onError={() => void stable.renew()} accessibilityIgnoresInvertColors /> : null}
    </View>
  );
}
