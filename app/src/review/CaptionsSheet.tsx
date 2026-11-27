import { Modal, Pressable, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PillButton } from '@/ui/PillButton';
import { Row } from '@/ui/layout';
import { SegmentedControl, Toggle } from '@/ui/controls';
import { Text } from '@/ui/type';
import { ThemeScope, makeStyles, useTheme } from '@/ui/theme';
import { useLayoutMotion } from '@/ui/motion';
import { CAPTION_STYLES, captionHint, type CaptionsSheetProps } from './captions';

const useStyles = makeStyles((t) => ({
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(11,18,32,0.32)' },
  wrap: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: t.scheme === 'dark' ? '#141A26' : t.color.fill,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: 20,
    gap: 14,
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    borderWidth: t.scheme === 'dark' ? 1 : 0,
    borderColor: t.color.hairline,
  },
  grabber: { alignSelf: 'center', width: 36, height: 5, borderRadius: 3, backgroundColor: t.color.track, marginTop: -8 },
}));

/** Android and web: Kilo's bottom sheet (radius 28 on top, scrim 0.32). iOS is `CaptionsSheet.ios.tsx`. */
export function CaptionsSheet({ open, captions, onChange, onClose }: CaptionsSheetProps) {
  const t = useTheme();
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <ThemeScope appearance={t.scheme}>
        <Body captions={captions} onChange={onChange} onClose={onClose} />
      </ThemeScope>
    </Modal>
  );
}

function Body({ captions, onChange, onClose }: Omit<CaptionsSheetProps, 'open'>) {
  const s = useStyles();
  const m = useLayoutMotion();
  const insets = useSafeAreaInsets();
  return (
    <>
      <Pressable style={s.scrim} onPress={onClose} accessibilityLabel="Close captions" accessibilityRole="button" />
      <View style={s.wrap} pointerEvents="box-none">
        <Animated.View entering={m.sheetIn} style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 20) }]}>
          <View style={s.grabber} />
          <Text variant="titleSm" accessibilityRole="header">
            Captions
          </Text>
          <Row
            title="Burn in captions"
            subtitle="Off: add them in TikTok or Instagram"
            right={<Toggle value={captions.enabled} onValueChange={(enabled) => onChange({ ...captions, enabled })} accessibilityLabel="Burn in captions" testID="captions-toggle" />}
          />
          <View style={{ gap: 6, opacity: captions.enabled ? 1 : 0.5 }} pointerEvents={captions.enabled ? 'auto' : 'none'}>
            <SegmentedControl segments={CAPTION_STYLES} value={captions.style} onChange={(style) => onChange({ ...captions, style })} accessibilityLabel="Caption style" />
            <Text variant="label" tone="muted">
              {captionHint(captions.style)}
            </Text>
          </View>
          <PillButton label="Done" height={52} onPress={onClose} testID="captions-done" />
        </Animated.View>
      </View>
    </>
  );
}
