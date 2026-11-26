import type { ReactNode } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, groundGradient, space } from './tokens';
import { OfflineBanner } from './OfflineBanner';

export interface ScreenProps {
  children: ReactNode;
  /** Scrolls the body. Off for screens that lay out to the full height (Review). */
  scroll?: boolean;
  /** Pull to refresh (scrolling screens only). */
  refreshing?: boolean;
  onRefresh?: () => void;
  /** Pinned below the body, inside the gutter (primary actions). */
  footer?: ReactNode;
  /** Gap between direct children. */
  gap?: number;
  /** False when a tab bar below the screen already handles the bottom inset. */
  bottomInset?: boolean;
  contentStyle?: ViewStyle;
  testID?: string;
}

/** The sky-tint gradient ground with safe areas and the 20pt gutter of the mock-up. */
export function Screen({
  children,
  scroll = true,
  refreshing,
  onRefresh,
  footer,
  gap = space.xl,
  bottomInset = true,
  contentStyle,
  testID,
}: ScreenProps) {
  const insets = useSafeAreaInsets();
  const top = insets.top > 0 ? insets.top + space.xs : space.gutter;
  const bottom = bottomInset ? Math.max(insets.bottom, space.gutter) : space.gutter;
  const body: ViewStyle = { gap, paddingHorizontal: space.gutter };

  return (
    <View style={styles.root} testID={testID}>
      <LinearGradient
        colors={groundGradient.colors}
        locations={groundGradient.locations}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <View style={{ paddingTop: top }}>
        <OfflineBanner />
      </View>
      {scroll ? (
        <ScrollView
          style={styles.flex}
          contentContainerStyle={[body, { paddingBottom: footer ? space.xl : bottom }, contentStyle]}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            onRefresh ? (
              <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={color.accent} />
            ) : undefined
          }
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.flex, body, { paddingBottom: footer ? 0 : bottom }, contentStyle]}>{children}</View>
      )}
      {footer ? (
        <View style={{ paddingHorizontal: space.gutter, paddingTop: footer ? space.md : 0, paddingBottom: bottom, gap: 10 }}>
          {footer}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.ground },
  flex: { flex: 1 },
});
