import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Stack } from 'expo-router';
import type { NativeStackNavigationOptions } from 'expo-router/native-stack';
import { haptic } from './haptics';
import { PressableScale } from './PressableScale';
import { SymbolIcon } from './SymbolIcon';
import { sfSymbolFor } from './symbols';
import { fontFamily, size } from './tokens';
import { Text } from './type';
import { ThemeScope, useTheme } from './theme';
import { motionHaptics } from './motionPresets';
import type { ScreenHeaderConfig, ScreenHeaderResult } from './ScreenHeader.types';

export type { HeaderAction, ScreenHeaderConfig, ScreenHeaderResult } from './ScreenHeader.types';

type Options = NativeStackNavigationOptions;

/** Holds the latest `right` element, so the bar can show it without re-configuring on every render. */
function createSlot() {
  let value: ReactNode = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: ReactNode) {
      if (next === value) return;
      value = next;
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

function Slot({ slot }: { slot: ReturnType<typeof createSlot> }) {
  return <>{useSyncExternalStore(slot.subscribe, slot.get, slot.get)}</>;
}
type RightItems = ReturnType<NonNullable<Options['unstable_headerRightItems']>>;

/**
 * iOS: the native navigation bar for this route, set through `<Stack.Screen options>`. On iOS
 * 26 it is transparent Liquid Glass with the content scrolling under it and the actions as
 * glass bar buttons (a `menu` action is a native menu that morphs out of its button); on
 * earlier iOS the standard bar. Titles are Inter 600 (17 inline, 34 large) in the screen's
 * theme. Never put a `GlassView` in the bar: the system draws its glass.
 *
 * Options only change when what they show changes: handlers are read through a ref, so a
 * screen re-rendering with new closures does not re-configure the bar.
 */
export function useScreenHeader(header: ScreenHeaderConfig | undefined): ScreenHeaderResult {
  const t = useTheme();
  const latest = useRef(header);
  latest.current = header;

  const actionsKey =
    header?.actions?.map((a) => `${a.label}|${a.icon}|${a.prominent ? 1 : 0}|${a.disabled ? 1 : 0}|${a.menu?.map((m) => `${m.label}/${m.subtitle ?? ''}/${m.disabled ? 1 : 0}`).join(';') ?? ''}`).join(',') ?? '';
  const hasBack = !!header?.onBack;
  const { title, meta, large, noBack } = header ?? {};
  const hasRight = !!header?.right;
  const [slot] = useState(() => {
    const s = createSlot();
    s.set(header?.right ?? null);
    return s;
  });
  useEffect(() => {
    slot.set(header?.right ?? null);
  });

  const options = useMemo<Options | null>(() => {
    if (title === undefined) return null;
    const actions = latest.current?.actions ?? [];
    const opts: Options = {
      headerShown: true,
      title,
      headerLargeTitle: !!large,
      headerBackVisible: !noBack && !hasBack,
      gestureEnabled: !hasBack,
      headerTintColor: t.color.ink,
      headerTitleStyle: { fontFamily: fontFamily[600], fontSize: 17, color: t.color.ink },
      headerLargeTitleStyle: { fontFamily: fontFamily[600], fontSize: 34, color: t.color.ink },
    };
    if (hasBack) {
      opts.headerLeft = () => (
        <PressableScale
          onPress={() => latest.current?.onBack?.()}
          motion="icon"
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={4}
          style={{ width: size.touch, height: size.touch, alignItems: 'center', justifyContent: 'center' }}
        >
          <SymbolIcon name="chevronLeft" size={20} strokeWidth={2.2} color={t.color.ink} />
        </PressableScale>
      );
    }
    if (hasRight) {
      opts.headerRight = () => (
        <ThemeScope appearance={t.scheme}>
          <Slot slot={slot} />
        </ThemeScope>
      );
    } else if (actions.length || meta) {
      opts.unstable_headerRightItems = () => {
        const items: RightItems = [];
        if (meta) {
          items.push({
            type: 'custom',
            hidesSharedBackground: true,
            element: (
              <ThemeScope appearance={t.scheme}>
                <Text variant="secondary" tone="muted" tabular>
                  {meta}
                </Text>
              </ThemeScope>
            ),
          });
        }
        actions.forEach((a, i) => {
          const shared = {
            label: a.label,
            accessibilityLabel: a.label,
            icon: { type: 'sfSymbol' as const, name: sfSymbolFor(a.icon) },
            variant: a.prominent ? ('prominent' as const) : ('plain' as const),
            tintColor: a.prominent ? t.color.accent : undefined,
            disabled: a.disabled,
          };
          if (a.menu?.length) {
            items.push({
              ...shared,
              type: 'menu',
              menu: {
                items: a.menu.map((m, j) => ({
                  type: 'action' as const,
                  label: m.label,
                  description: m.subtitle,
                  icon: m.sf || m.icon ? { type: 'sfSymbol' as const, name: m.sf ?? sfSymbolFor(m.icon!) } : undefined,
                  destructive: m.destructive,
                  disabled: m.disabled,
                  onPress: () => latest.current?.actions?.[i]?.menu?.[j]?.onPress(),
                })),
              },
            });
          } else {
            items.push({
              ...shared,
              type: 'button',
              onPress: () => {
                if (a.prominent) haptic(motionHaptics.primaryPress);
                latest.current?.actions?.[i]?.onPress();
              },
            });
          }
        });
        return items;
      };
    }
    return opts;
    // `actionsKey` stands for the actions' content; their handlers are read through the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, meta, large, noBack, hasBack, hasRight, actionsKey, t, slot]);

  if (!options) return { native: false, element: null };
  return { native: true, element: <Stack.Screen options={options} /> };
}
