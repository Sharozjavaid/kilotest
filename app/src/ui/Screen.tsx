import { useContext, type ReactNode } from 'react';
import { Platform, RefreshControl, ScrollView, StyleSheet, View, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { HeaderHeightContext } from 'expo-router/react-navigation';
import { space } from './tokens';
import { OfflineBanner } from './OfflineBanner';
import { DEFAULT_SCREEN_APPEARANCE, ThemeScope, useTheme, type Appearance } from './theme';
import { useScreenHeader } from './ScreenHeader';
import type { ScreenHeaderConfig } from './ScreenHeader.types';

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
  /**
   * The route's header. iOS: the native navigation bar (Liquid Glass on 26, content scrolling
   * under it, large title when `large`). Android and web: the in-content `Header` row, as
   * before. Route screens only; sheets and modals keep `<Header>` in their content.
   */
  header?: ScreenHeaderConfig;
  /**
   * `auto` follows the system appearance; `light` / `dark` force one (the recorder is `dark`).
   * Default `DEFAULT_SCREEN_APPEARANCE` (`light` until every screen reads the theme).
   */
  appearance?: Appearance;
}

/** The sky-tint gradient ground with safe areas and the 20pt gutter of the mock-up. Theme-aware. */
export function Screen({ appearance = DEFAULT_SCREEN_APPEARANCE, ...props }: ScreenProps) {
  return (
    <ThemeScope appearance={appearance}>
      <ScreenBody {...props} />
    </ThemeScope>
  );
}

function ScreenBody({ children, scroll = true, refreshing, onRefresh, footer, gap = space.xl, bottomInset = true, contentStyle, testID, header }: Omit<ScreenProps, 'appearance'>) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const nav = useScreenHeader(header);
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const nativeHeader = nav.native;
  const bottom = bottomInset ? Math.max(insets.bottom, space.gutter) : space.gutter;
  const body: ViewStyle = { gap, paddingHorizontal: space.gutter };
  const g = t.groundGradient;

  // With the native bar the scroll view must be the screen's first view, so UIKit finds it for
  // the large title and the scroll-edge effect: the ground is a background image, not a view.
  const ground: ViewStyle | null = Platform.OS === 'web' ? null : { backgroundImage: `linear-gradient(180deg, ${g.colors[0]} 0%, ${g.colors[1]} 36%, ${g.colors[2]} 100%)` };

  const inline = nativeHeader ? null : nav.element;
  const banner = <OfflineBanner />;

  let main: ReactNode;
  if (scroll) {
    main = (
      <ScrollView
        style={styles.flex}
        contentContainerStyle={[
          body,
          nativeHeader ? { paddingTop: space.xs } : null,
          // With the native bar, the scroll view's automatic insets already clear the home indicator.
          { paddingBottom: footer ? space.xl : nativeHeader ? space.gutter : bottom },
          contentStyle,
        ]}
        contentInsetAdjustmentBehavior={nativeHeader ? 'automatic' : undefined}
        keyboardShouldPersistTaps="handled"
        refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={t.color.accent} /> : undefined}
      >
        {nativeHeader ? <View style={styles.bannerInContent}>{banner}</View> : null}
        {inline}
        {children}
      </ScrollView>
    );
  } else {
    main = (
      <View style={[styles.flex, body, nativeHeader ? { paddingTop: headerHeight } : null, { paddingBottom: footer ? 0 : bottom }, contentStyle]}>
        {nativeHeader ? <View style={styles.bannerInContent}>{banner}</View> : null}
        {inline}
        {children}
      </View>
    );
  }

  const top = insets.top > 0 ? insets.top + space.xs : space.gutter;
  return (
    <View style={[styles.root, { backgroundColor: t.color.ground }, ground]} testID={testID}>
      {nav.element && nativeHeader ? nav.element : null}
      <StatusBar style={t.statusBar} />
      {Platform.OS === 'web' ? <LinearGradient colors={g.colors} locations={g.locations} style={StyleSheet.absoluteFill} pointerEvents="none" /> : null}
      {nativeHeader ? null : <View style={{ paddingTop: top }}>{banner}</View>}
      {main}
      {footer ? <View style={{ paddingHorizontal: space.gutter, paddingTop: space.md, paddingBottom: bottom, gap: 10 }}>{footer}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  bannerInContent: { marginHorizontal: -space.gutter },
});
