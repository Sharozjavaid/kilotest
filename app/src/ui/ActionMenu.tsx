import { useRef, useState, type ComponentRef } from 'react';
import { Modal, Pressable, View, useWindowDimensions } from 'react-native';
import Animated from 'react-native-reanimated';
import { IconButton } from './layout';
import { Icon } from './Icon';
import { PressableScale } from './PressableScale';
import { Text } from './type';
import { radius, size } from './tokens';
import { makeStyles, useColors } from './theme';
import { useLayoutMotion } from './motion';
import type { ActionMenuProps } from './ActionMenu.types';

export type { ActionMenuProps, MenuItem } from './ActionMenu.types';

const WIDTH = 280;

const useStyles = makeStyles((t) => ({
  scrim: { flex: 1 },
  card: { position: 'absolute', width: WIDTH, backgroundColor: t.color.fill, borderRadius: radius.lg, borderWidth: 1, borderColor: t.color.hairline, paddingVertical: 6, ...t.shadow.surface },
  title: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, minHeight: size.touch, paddingVertical: 8 },
  itemText: { flex: 1, gap: 2 },
}));

/**
 * A button that opens a menu (the New (+) menu of the design brief). Android and web: Kilo's
 * popover card (white, radius 16, `shadow.surface`) under the trigger; iOS is the native
 * SwiftUI menu that morphs out of a glass button (`ActionMenu.ios.tsx`).
 *
 * ```tsx
 * <ActionMenu icon="plus" label="New" items={[
 *   { label: 'Upload clips', subtitle: 'Kilo cuts them for you', icon: 'upload', sf: 'photo.on.rectangle.angled', onPress: pick },
 *   { label: 'Record with script', subtitle: 'Read a script, one line at a time', icon: 'camera', onPress: () => router.push('/record') },
 * ]} />
 * ```
 */
export function ActionMenu({ icon, label, items, title, testID }: ActionMenuProps) {
  const s = useStyles();
  const c = useColors();
  const m = useLayoutMotion();
  const anchor = useRef<ComponentRef<typeof View>>(null);
  const { width: screenW } = useWindowDimensions();
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);

  const open = () => {
    anchor.current?.measureInWindow((x: number, y: number, w: number, h: number) => {
      const left = Math.max(12, Math.min(screenW - WIDTH - 12, x + w - WIDTH));
      setAt({ top: y + h + 8, left });
    });
  };
  const close = () => setAt(null);

  return (
    <>
      <View ref={anchor} collapsable={false}>
        <IconButton icon={icon} label={label} onPress={open} testID={testID} />
      </View>
      <Modal visible={!!at} transparent animationType="none" onRequestClose={close} statusBarTranslucent>
        <Pressable style={s.scrim} onPress={close} accessibilityRole="button" accessibilityLabel="Close menu">
          {at ? (
            <Animated.View entering={m.appear} style={[s.card, { top: at.top, left: at.left }]} accessibilityRole="menu">
              {title ? (
                <Text variant="label" tone="muted" style={s.title}>
                  {title}
                </Text>
              ) : null}
              {items.map((it) => (
                <PressableScale
                  key={it.label}
                  motion="row"
                  pressedBackgroundColor={c.pressedRow}
                  disabled={it.disabled}
                  restingOpacity={it.disabled ? 0.5 : 1}
                  onPress={() => {
                    close();
                    it.onPress();
                  }}
                  accessibilityRole="menuitem"
                  accessibilityLabel={it.subtitle ? `${it.label}, ${it.subtitle}` : it.label}
                  testID={it.testID}
                  style={s.item}
                >
                  {it.icon ? <Icon name={it.icon} size={20} color={it.destructive ? c.cut : c.ink} /> : null}
                  <View style={s.itemText}>
                    <Text variant="body" weight={500} tone={it.destructive ? 'cut' : 'ink'}>
                      {it.label}
                    </Text>
                    {it.subtitle ? (
                      <Text variant="secondary" tone="muted">
                        {it.subtitle}
                      </Text>
                    ) : null}
                  </View>
                </PressableScale>
              ))}
            </Animated.View>
          ) : null}
        </Pressable>
      </Modal>
    </>
  );
}
