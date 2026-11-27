import { Platform } from 'react-native';
import { NativeTabs } from 'expo-router/native-tabs';
import { DEFAULT_SCREEN_APPEARANCE, resolveScheme, themeFor, useSystemScheme } from '@/ui/theme';
import { tabSymbol } from '@/ui/symbols';
import { UploadAccessory, useHasActiveUploads } from '@/ui/UploadAccessory';

/**
 * Videos / Styles / You on the platform's own tab bar (iOS and Android; web keeps `KiloTabBar`
 * in `_layout.tsx`, which the browser end-to-end suite drives).
 *
 * - iOS 26: the floating Liquid Glass `UITabBar`, SF Symbols, minimising on scroll down, and the
 *   uploads progress as the bottom accessory while files are on their way.
 * - iOS before 26: the standard `UITabBar` with its system blur.
 * - Android: Material bottom navigation with Material Symbols and the `accent` indicator.
 */
export default function TabsLayout() {
  const system = useSystemScheme();
  // The bar follows the screens' appearance (light until every screen reads the theme).
  const t = themeFor(resolveScheme(DEFAULT_SCREEN_APPEARANCE, system));
  const uploading = useHasActiveUploads();
  const android = Platform.OS === 'android';

  return (
    <NativeTabs
      minimizeBehavior="onScrollDown"
      tintColor={t.color.accent}
      iconColor={android ? { default: t.color.muted, selected: t.color.accent } : undefined}
      labelStyle={android ? { default: { color: t.color.muted }, selected: { color: t.color.accent } } : undefined}
      backgroundColor={android ? t.color.fill : undefined}
      indicatorColor={android ? t.color.chipOn : undefined}
      labelVisibilityMode="labeled"
    >
      {Platform.OS === 'ios' && uploading ? (
        <NativeTabs.BottomAccessory>
          <Accessory />
        </NativeTabs.BottomAccessory>
      ) : null}
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Videos</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={tabSymbol('videos')} md="video_library" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="styles">
        <NativeTabs.Trigger.Label>Styles</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={tabSymbol('styles')} md="tune" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="you">
        <NativeTabs.Trigger.Label>You</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={tabSymbol('user')} md="account_circle" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

function Accessory() {
  const placement = NativeTabs.BottomAccessory.usePlacement();
  return <UploadAccessory placement={placement} />;
}
