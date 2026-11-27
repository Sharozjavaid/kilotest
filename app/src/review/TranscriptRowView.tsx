import { memo, useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, View, type TextLayoutEvent } from 'react-native';

type TextLayoutLine = TextLayoutEvent['nativeEvent']['lines'][number];
import Animated, { Easing, ReduceMotion, runOnJS, useAnimatedStyle, useSharedValue, withSequence, withTiming, type SharedValue } from 'react-native-reanimated';
import { formatDuration } from '@/lib/format';
import { PressableScale } from '@/ui/PressableScale';
import { SymbolIcon } from '@/ui/SymbolIcon';
import { prefersReducedMotion } from '@/ui/a11y';
import { easings, timings } from '@/ui/motionPresets';
import { makeStyles, useColors } from '@/ui/theme';
import { fontFamily, radius } from '@/ui/tokens';
import { Text } from '@/ui/type';
import type { RowModel } from './rowModels';
import type { TranscriptRow } from './rows';

export type { RowOverlayInfo, RowOverlayItem } from './rowModels';

/**
 * Everything a row can ask the screen to do. One object for the life of the screen (its
 * functions read the latest state through a ref), so memoised rows never re-render for it.
 */
export interface RowActions {
  toggle: (segmentId: string) => void;
  seek: (row: TranscriptRow) => void;
  keepBoth: (segmentId: string) => void;
  overlayHidden: (overlayId: string, hidden: boolean) => void;
  /** Long press: Play this line, Cut / Put back, Keep both, Show / Hide B-roll. */
  menu: (model: RowModel) => void;
  /** A row's cut / restore animation `n` finished (or its row scrolled away). */
  pulseDone: (segmentId: string, n: number) => void;
  /** A row's stepper highlight `n` finished. */
  flashDone: (segmentId: string, n: number) => void;
}

const native = Platform.OS !== 'web';
const standard = Easing.bezier(easings.standard[0], easings.standard[1], easings.standard[2], easings.standard[3]);

export const ROW_BAR = 3;
export const ROW_BAR_ACTIVE = 4;

const useStyles = makeStyles((t) => {
  const dark = t.scheme === 'dark';
  return {
    row: { borderRadius: radius.row, borderWidth: 1, paddingVertical: 12, paddingLeft: 14, paddingRight: 12, flexDirection: 'row', gap: 10, overflow: 'hidden', borderCurve: 'continuous' },
    kept: { backgroundColor: t.color.surface, borderColor: t.color.hairline },
    keptActive: { backgroundColor: dark ? 'rgba(76,125,255,0.14)' : 'rgba(31,94,255,0.08)', borderColor: dark ? 'rgba(76,125,255,0.35)' : 'rgba(31,94,255,0.22)' },
    cut: { backgroundColor: dark ? 'transparent' : 'rgba(255,255,255,0.55)', borderColor: t.color.cut },
    cutActive: { backgroundColor: dark ? 'rgba(240,135,90,0.08)' : 'rgba(255,255,255,0.85)' },
    bar: { position: 'absolute', left: 0, top: 0, bottom: 0, width: ROW_BAR, backgroundColor: t.color.accent },
    barActive: { width: ROW_BAR_ACTIVE },
    body: { flex: 1, gap: 4 },
    line: { fontFamily: fontFamily[400], fontSize: 15, lineHeight: 21, color: t.color.ink },
    lineMuted: { color: t.color.muted },
    strike: { textDecorationLine: 'line-through' },
    silence: { fontStyle: 'italic' },
    subline: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
    inlineButton: { minHeight: 24, justifyContent: 'center' },
    side: { alignItems: 'flex-end', justifyContent: 'space-between', gap: 6, minWidth: 34 },
    time: { minWidth: 34, minHeight: 21, alignItems: 'flex-end', justifyContent: 'flex-start' },
    mark: { minWidth: 28, minHeight: 24, alignItems: 'flex-end', justifyContent: 'flex-end' },
    fade: { ...StyleSheet.absoluteFill, borderRadius: radius.row, borderWidth: 1 },
    flash: { ...StyleSheet.absoluteFill, borderRadius: radius.row, borderWidth: 2, borderColor: t.color.accent },
    strikeLine: { position: 'absolute', height: 1.25, backgroundColor: t.color.muted, transformOrigin: 'left' },
  };
});

/**
 * A transcript row (design brief 4.6). Kept: a `surface` card with a 3pt accent bar on the
 * left, ink text. Cut: a paler card with a 1px `cut` outline, struck muted text and why it was
 * cut ("Keep both" on retakes). Playing: the kept fill tints and the bar grows to 4pt; the
 * text never reflows. Tap toggles, the time seeks, long press opens the row's menu.
 *
 * Motion (`cutToggle`, native only): the row that was just tapped (`pulse`) cross-fades from
 * its old fill and outline (160 ms) and, when cut, draws its strike-through left to right
 * (200 ms). Only that row holds animated values while it animates; the other rows are plain
 * views, memoised on a stable model, so a list of thousands scrolls at full frame rate.
 */
export const TranscriptRowView = memo(function TranscriptRowView({
  model,
  active,
  pulse,
  flash,
  actions,
}: {
  model: RowModel;
  active: boolean;
  /** Non-zero (a nonce) right after this row was toggled: plays the cut / restore motion. */
  pulse: number;
  /** Non-zero (a nonce) when the cut stepper landed on this row: flashes the outline. */
  flash: number;
  actions: RowActions;
}) {
  const s = useStyles();
  const c = useColors();
  const { row, why, keepBoth, hasOverlay, overlays } = model;
  const time = formatDuration(row.proxyStart);
  const reason = row.keep ? null : (why ?? row.reasonLabel ?? 'Cut');
  const hidden = overlays?.hidden ?? [];
  const firstShown = overlays?.shown[0];
  const hiddenNote = hidden.length ? `. ${hidden.map((h) => h.label).join(' and ')} left out of ${overlays!.variantLabel}` : '';
  const animating = native && pulse > 0;
  const drawStrike = animating && !row.keep && !prefersReducedMotion();
  const muted = !row.keep || row.isSilence;
  const lineStyle = [s.line, muted && s.lineMuted, row.isSilence && s.silence];

  const markColor = row.keep ? c.accent : c.muted;
  const marker = firstShown && overlays ? (
    <Pressable
      onPress={() => actions.overlayHidden(firstShown.id, true)}
      accessibilityRole="button"
      accessibilityLabel={`${firstShown.label} on this line. Leave it out of ${overlays.variantLabel}`}
      hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
      style={s.mark}
      testID={`overlay-hide-${firstShown.id}`}
    >
      <View testID={`overlay-mark-${row.segmentId}`}>
        <SymbolIcon name="broll" size={14} color={markColor} />
      </View>
    </Pressable>
  ) : hasOverlay ? (
    <View style={s.mark} testID={`overlay-mark-${row.segmentId}`}>
      <SymbolIcon name="broll" size={14} color={markColor} />
    </View>
  ) : null;

  return (
    <PressableScale
      onPress={() => actions.toggle(row.segmentId)}
      onLongPress={native ? () => actions.menu(model) : undefined}
      delayLongPress={450}
      motion="row"
      accessibilityRole="button"
      accessibilityLabel={`${row.text}. ${row.keep ? 'Kept' : `Cut: ${reason}`}${hasOverlay ? '. Has B-roll or a graphic' : ''}${hiddenNote}`}
      accessibilityHint={row.keep ? 'Cuts this line' : 'Puts this line back'}
      accessibilityState={{ selected: row.keep }}
      aria-pressed={row.keep}
      testID={`row-${row.segmentId}`}
      style={[s.row, row.keep ? [s.kept, active && s.keptActive] : [s.cut, active && s.cutActive]]}
    >
      {animating ? <FillFade key={pulse} wasKept={!row.keep} active={active} onDone={drawStrike ? undefined : () => actions.pulseDone(row.segmentId, pulse)} /> : null}
      {row.keep ? <View style={[s.bar, active && s.barActive]} /> : null}
      <View style={s.body}>
        {drawStrike ? (
          <DrawnStrike key={pulse} text={row.text} style={lineStyle} onDone={() => actions.pulseDone(row.segmentId, pulse)} />
        ) : (
          <Text style={[lineStyle, !row.keep && s.strike]} maxFontSizeMultiplier={1.6}>
            {row.text}
          </Text>
        )}
        {reason && !row.isSilence ? (
          <View style={s.subline}>
            <Text variant="label" weight={600} tone="cut" testID={`why-${row.segmentId}`}>
              {reason}
            </Text>
            {keepBoth ? (
              <Pressable
                onPress={() => actions.keepBoth(row.segmentId)}
                accessibilityRole="button"
                accessibilityLabel={`Keep both takes: put “${row.text}” back as well`}
                hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
                style={s.inlineButton}
                testID={`keep-both-${row.segmentId}`}
              >
                <Text variant="label" weight={600} tone="accent">
                  Keep both
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {reason && row.isSilence ? (
          <Text variant="label" weight={600} tone="cut">
            {row.reasonLabel}
          </Text>
        ) : null}
        {hidden.map((h) => (
          <View key={h.id} style={s.subline} testID={`hidden-overlay-${h.id}`}>
            <Text variant="label" tone="muted">
              {h.label} left out of {overlays!.variantLabel}
            </Text>
            <Pressable
              onPress={() => actions.overlayHidden(h.id, false)}
              accessibilityRole="button"
              accessibilityLabel={`Show ${h.label} in ${overlays!.variantLabel}`}
              hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
              style={s.inlineButton}
              testID={`overlay-show-${h.id}`}
            >
              <Text variant="label" weight={600} tone="accent">
                Show
              </Text>
            </Pressable>
          </View>
        ))}
      </View>
      <View style={s.side}>
        <Pressable
          onPress={() => actions.seek(row)}
          accessibilityRole="button"
          accessibilityLabel={`Play from ${time}`}
          hitSlop={{ top: 12, bottom: 12, left: 8, right: 12 }}
          style={s.time}
          testID={`seek-${row.segmentId}`}
        >
          <Text variant="label" tone={active ? 'accent' : 'muted'} weight={active ? 600 : 400} tabular>
            {time}
          </Text>
        </Pressable>
        {marker}
      </View>
      {native && flash > 0 ? <FlashOutline key={flash} onDone={() => actions.flashDone(row.segmentId, flash)} /> : null}
    </PressableScale>
  );
});

/** The row's previous fill and outline, fading out over the new ones (beneath the text). */
function FillFade({ wasKept, active, onDone }: { wasKept: boolean; active: boolean; onDone?: () => void }) {
  const s = useStyles();
  const o = useSharedValue(1);
  useEffect(() => {
    o.value = withTiming(0, { duration: timings.cutFill.duration, easing: standard, reduceMotion: ReduceMotion.Never }, (finished) => {
      if (finished && onDone) runOnJS(onDone)();
    });
    // A recycled or unmounted row ends its motion too.
    return () => onDone?.();
    // Runs once per pulse (the parent keys this view by it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const style = useAnimatedStyle(() => ({ opacity: o.value }));
  return <Animated.View pointerEvents="none" style={[s.fade, wasKept ? [s.kept, active && s.keptActive] : s.cut, style]} />;
}

/** Text without its strike-through, and the strike drawn over it line by line, left to right. */
function DrawnStrike({ text, style, onDone }: { text: string; style: object; onDone: () => void }) {
  const s = useStyles();
  const [lines, setLines] = useState<TextLayoutLine[]>([]);
  const p = useSharedValue(0);
  useEffect(() => {
    p.value = withTiming(1, { duration: timings.cutStrike.duration, easing: standard, reduceMotion: ReduceMotion.System }, (finished) => {
      if (finished) runOnJS(onDone)();
    });
    return () => onDone();
    // Once per pulse.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <View>
      <Text style={style} maxFontSizeMultiplier={1.6} onTextLayout={(e) => setLines(e.nativeEvent.lines)}>
        {text}
      </Text>
      {lines.map((l, i) => (
        <StrikeLine key={i} index={i} count={lines.length} line={l} progress={p} style={s.strikeLine} />
      ))}
    </View>
  );
}

function StrikeLine({ index, count, line, progress, style }: { index: number; count: number; line: TextLayoutLine; progress: SharedValue<number>; style: object }) {
  const a = useAnimatedStyle(() => ({ transform: [{ scaleX: Math.min(1, Math.max(0, progress.value * count - index)) }] }));
  // Through the middle of the lower-case letters, where the native strike sits.
  const top = line.y + line.ascender - line.xHeight / 2;
  return <Animated.View pointerEvents="none" style={[style, { left: line.x, top, width: line.width }, a]} />;
}

/** The stepper landed here: the outline flashes `accent` for 600 ms. */
function FlashOutline({ onDone }: { onDone: () => void }) {
  const s = useStyles();
  const o = useSharedValue(0);
  useEffect(() => {
    const t = { easing: standard, reduceMotion: ReduceMotion.Never };
    o.value = withSequence(
      withTiming(1, { duration: 120, ...t }),
      withTiming(1, { duration: 300, ...t }),
      withTiming(0, { duration: 180, ...t }, (finished) => {
        if (finished) runOnJS(onDone)();
      }),
    );
    return () => onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const style = useAnimatedStyle(() => ({ opacity: o.value }));
  return <Animated.View pointerEvents="none" style={[s.flash, style]} />;
}
