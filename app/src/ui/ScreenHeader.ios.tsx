import { useMemo, useRef } from 'react';
import { Stack } from 'expo-router';
import type { NativeStackNavigationOptions } from 'expo-router/native-stack';
import { haptic } from './haptics';
import { PressableScale } from './PressableScale';
import { SymbolIcon } from './SymbolIcon';
import { sfSymbolFor } from './symbols';
import { color, size } from './tokens';
import { Text } from './type';
import type { ScreenHeaderConfig, ScreenHeaderResult } from './ScreenHeader.types';

export type { HeaderAction, ScreenHeaderConfig, ScreenHeaderResult } from './ScreenHeader.types';

type Options = NativeStackNavigationOptions;

/**
 * iOS: the native navigation bar for this route, set through `<Stack.Screen options>`. On iOS
 * 26 it is transparent Liquid Glass with the content scrolling under it and the actions as
 * glass bar buttons; on earlier iOS the standard bar. The root stack's defaults (fonts, tint,
 * minimal back button) are in `src/app/_layout.tsx`.
 *
 * Options only change when what they show changes: the handlers are read through a ref, so a
 * screen re-rendering with new closures does not re-configure the bar.
 */
export function useScreenHeader(header: ScreenHeaderConfig | undefined): ScreenHeaderResult {
  const latest = useRef(header);
  latest.current = header;

  const actionsKey = header?.actions?.map((a) => `${a.label}|${a.icon}|${a.prominent ? 1 : 0}|${a.disabled ? 1 : 0}`).join(',') ?? '';
  const hasBack = !!header?.onBack;
  const { title, meta, large, noBack, right } = header ?? {};

  const options = useMemo<Options | null>(() => {
    if (title === undefined) return null;
    const actions = latest.current?.actions ?? [];
    const opts: Options = {
      headerShown: true,
      title,
      headerLargeTitle: !!large,
      headerBackVisible: !noBack && !hasBack,
      gestureEnabled: !hasBack,
    };
    if (hasBack) {
      opts.headerLeft = () => (
        <PressableScale
          onPress={() => latest.current?.onBack?.()}
          motion="icon"
          haptic={false}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={4}
          style={{ width: size.touch, height: size.touch, alignItems: 'center', justifyContent: 'center' }}
        >
          <SymbolIcon name="chevronLeft" size={20} strokeWidth={2.2} />
        </PressableScale>
      );
    }
    if (right) {
      opts.headerRight = () => right;
    } else if (actions.length || meta) {
      opts.unstable_headerRightItems = () => [
        ...(meta
          ? [{ type: 'custom' as const, hidesSharedBackground: true, element: <Text variant="secondary" tone="muted">{meta}</Text> }]
          : []),
        ...actions.map((a, i) => ({
          type: 'button' as const,
          label: a.label,
          accessibilityLabel: a.label,
          icon: { type: 'sfSymbol' as const, name: sfSymbolFor(a.icon) },
          variant: a.prominent ? ('prominent' as const) : ('plain' as const),
          tintColor: a.prominent ? color.accent : undefined,
          disabled: a.disabled,
          onPress: () => {
            haptic(a.prominent ? 'medium' : 'light');
            latest.current?.actions?.[i]?.onPress();
          },
        })),
      ];
    }
    return opts;
    // `actionsKey` stands for the actions' content; their handlers are read through the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, meta, large, noBack, hasBack, right, actionsKey]);

  if (!options) return { native: false, element: null };
  return { native: true, element: <Stack.Screen options={options} /> };
}
