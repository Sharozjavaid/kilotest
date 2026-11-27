import { useState } from 'react';
import { ActionSheetIOS, Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import { Card, PillButton, Row, Text, makeStyles, useTheme, type IconName } from '@/ui';

export interface MoreAction {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}

const useStyles = makeStyles((t) => ({
  sheet: { position: 'absolute', left: 12, right: 12, bottom: 24, backgroundColor: t.color.ground, borderRadius: 28 },
}));

/**
 * Export's "More" button (design brief 4.7): Send to TikTok, Send to Instagram, Mark as posted.
 * iOS: the native action sheet (glass on iOS 26). Android and web: a bottom sheet of the same
 * actions. The button itself is a secondary pill, content-filled because it sits in the glass
 * footer bar (never glass on glass).
 */
export function MoreActions({ actions, icon = 'more', style, disabled }: { actions: MoreAction[]; icon?: IconName; style?: object; disabled?: boolean }) {
  const s = useStyles();
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const enabled = actions.filter((a) => !a.disabled);

  const show = () => {
    if (Platform.OS === 'ios') {
      const options = [...enabled.map((a) => a.label), 'Cancel'];
      ActionSheetIOS.showActionSheetWithOptions({ options, cancelButtonIndex: options.length - 1, userInterfaceStyle: t.scheme }, (i) => enabled[i]?.onPress());
      return;
    }
    setOpen(true);
  };

  return (
    <>
      <PillButton variant="secondary" surface="content" label="More" icon={icon} height={44} onPress={show} disabled={disabled || !enabled.length} style={style} testID="export-more" />
      {Platform.OS === 'ios' ? null : (
        <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
          <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: t.scheme === 'dark' ? 'rgba(0,0,0,0.5)' : 'rgba(11,18,32,0.32)' }]} onPress={() => setOpen(false)} accessibilityRole="button" accessibilityLabel="Close" />
          <View style={s.sheet}>
            <Card gap={2}>
              <Text variant="bodyLg" accessibilityRole="header">
                More
              </Text>
              {enabled.map((a, i) => (
                <Row
                  key={a.label}
                  divider={i > 0}
                  title={a.label}
                  onPress={() => {
                    setOpen(false);
                    a.onPress();
                  }}
                />
              ))}
              <PillButton variant="text" label="Cancel" onPress={() => setOpen(false)} />
            </Card>
          </View>
        </Modal>
      )}
    </>
  );
}
