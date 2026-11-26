import { View, type StyleProp, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { color, radius } from './tokens';

/** Thumbnail with the track-colour placeholder of the mock-up (40 x 56 by default). */
export function Thumb({ uri, width = 40, height = 56, r = radius.sm, style }: { uri?: string | null; width?: number; height?: number; r?: number; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ width, height, borderRadius: r, backgroundColor: color.track, overflow: 'hidden', flexShrink: 0 }, style]}>
      {uri ? <Image source={{ uri }} style={{ width, height }} contentFit="cover" accessibilityIgnoresInvertColors /> : null}
    </View>
  );
}
