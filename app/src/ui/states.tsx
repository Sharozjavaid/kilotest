import { useEffect, useRef, useState } from 'react';
import { Animated, Platform, StyleSheet, View, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native';
import Reanimated, { useAnimatedStyle } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { useColors } from './theme';
import { useShimmer } from './motion';
import { distances } from './motionPresets';
import { router } from 'expo-router';
import { errorMessage, isKiloApiError } from '@/api/errors';
import { color, radius, space } from './tokens';
import { Text } from './type';
import { Icon, type IconName } from './Icon';
import { PillButton } from './PillButton';
import { Card } from './Card';

type SkeletonProps = { width?: DimensionValue; height?: number; radius?: number; style?: StyleProp<ViewStyle> };

/**
 * A placeholder block in the track colour. Native: the brief's `shimmer` (a highlight band 40%
 * wide, white at 45%, sweeping every 1400 ms on the UI thread; still under Reduce Motion).
 * Web: the opacity pulse it always had.
 */
export function Skeleton(props: SkeletonProps) {
  return Platform.OS === 'web' ? <SkeletonPulse {...props} /> : <SkeletonShimmer {...props} />;
}

function SkeletonShimmer({ width = '100%', height = 16, radius: r = radius.sm, style }: SkeletonProps) {
  const c = useColors();
  const t = useShimmer();
  const [w, setW] = useState(0);
  const band = Math.max(1, w * distances.shimmerBand);
  const sweep = useAnimatedStyle(() => ({ transform: [{ translateX: -band + t.value * (w + band) }] }), [w, band]);
  return (
    <View
      style={[{ width, height, borderRadius: r, backgroundColor: c.track, overflow: 'hidden' }, style]}
      onLayout={(e) => {
        const next = e.nativeEvent.layout.width;
        if (Math.abs(next - w) > 0.5) setW(next);
      }}
    >
      {w > 0 ? (
        <Reanimated.View style={[{ position: 'absolute', top: 0, bottom: 0, left: 0, width: band }, sweep]} pointerEvents="none">
          <LinearGradient
            colors={['rgba(255,255,255,0)', `rgba(255,255,255,${distances.shimmerAlpha})`, 'rgba(255,255,255,0)']}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={StyleSheet.absoluteFill}
          />
        </Reanimated.View>
      ) : null}
    </View>
  );
}

function SkeletonPulse({ width = '100%', height = 16, radius: r = radius.sm, style }: SkeletonProps) {
  const opacity = useRef(new Animated.Value(0.6)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: false }),
        Animated.timing(opacity, { toValue: 0.6, duration: 700, useNativeDriver: false }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return <Animated.View style={[{ width, height, borderRadius: r, backgroundColor: color.track, opacity }, style]} />;
}

/** Skeleton for a list of video rows. */
export function SkeletonRows({ count = 3 }: { count?: number }) {
  return (
    <View accessibilityLabel="Loading" accessibilityRole="progressbar" style={{ gap: 12 }}>
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={styles.skelRow}>
          <Skeleton width={40} height={56} />
          <View style={{ flex: 1, gap: 8 }}>
            <Skeleton width="70%" height={14} />
            <Skeleton width="45%" height={12} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** An error with the message and a retry button. */
export function ErrorState({ error, onRetry, title = "Couldn't load this" }: { error: unknown; onRetry?: () => void; title?: string }) {
  // Gone for good (deleted, or a wrong link): trying again cannot help, going home can.
  const c = useColors();
  const gone = isKiloApiError(error) && error.isNotFound;
  const heading = gone ? "This isn't here" : title;
  return (
    <Card gap={12} padding={24} style={styles.center} accessibilityLabel={heading} testID={gone ? 'not-found' : 'error-state'}>
      <Icon name="alert" size={28} color={c.cut} />
      <Text variant="bodyLg" center>
        {heading}
      </Text>
      <Text variant="secondary" tone="muted" center>
        {gone ? 'It may have been deleted, or the link is wrong.' : errorMessage(error)}
      </Text>
      {gone ? (
        <PillButton variant="secondary" label="Go to Home" onPress={() => router.replace('/')} height={44} />
      ) : onRetry ? (
        <PillButton variant="secondary" label="Try again" icon="refresh" onPress={onRetry} height={44} />
      ) : null}
    </Card>
  );
}

/** Friendly empty state with an optional action. */
export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: IconName;
  title: string;
  body: string;
  action?: { label: string; onPress: () => void };
}) {
  const c = useColors();
  return (
    <Card gap={10} padding={24} style={styles.center}>
      <View style={[styles.emptyIcon, { backgroundColor: c.chipOn }]}>
        <Icon name={icon} size={24} color={c.accent} />
      </View>
      <Text variant="bodyLg" center>
        {title}
      </Text>
      <Text variant="secondary" tone="muted" center>
        {body}
      </Text>
      {action ? <PillButton variant="secondary" label={action.label} onPress={action.onPress} height={44} /> : null}
    </Card>
  );
}

/** Full-screen centred loading for screens that need their data before layout. */
export function LoadingBlock({ label = 'Loading' }: { label?: string }) {
  return (
    <View style={{ gap: space.lg }} accessibilityLabel={label} accessibilityRole="progressbar">
      <Skeleton height={120} radius={radius.card} />
      <Skeleton height={36} />
      <Skeleton height={48} radius={radius.row} />
      <Skeleton height={48} radius={radius.row} />
      <Skeleton height={48} radius={radius.row} />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center' },
  skelRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64 },
  emptyIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: color.skyTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
