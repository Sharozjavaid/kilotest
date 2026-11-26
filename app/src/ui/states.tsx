import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native';
import { errorMessage } from '@/api/errors';
import { color, radius, space } from './tokens';
import { Text } from './type';
import { Icon, type IconName } from './Icon';
import { PillButton } from './PillButton';
import { Card } from './Card';

/** A pulsing placeholder block in the track colour. */
export function Skeleton({ width = '100%', height = 16, radius: r = radius.sm, style }: { width?: DimensionValue; height?: number; radius?: number; style?: StyleProp<ViewStyle> }) {
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
  return (
    <Card gap={12} padding={24} style={styles.center} accessibilityLabel={title}>
      <Icon name="alert" size={28} color={color.cut} />
      <Text variant="bodyLg" center>
        {title}
      </Text>
      <Text variant="secondary" tone="muted" center>
        {errorMessage(error)}
      </Text>
      {onRetry ? <PillButton variant="secondary" label="Try again" icon="refresh" onPress={onRetry} height={44} /> : null}
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
  return (
    <Card gap={10} padding={24} style={styles.center}>
      <View style={styles.emptyIcon}>
        <Icon name={icon} size={24} color={color.accent} />
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
