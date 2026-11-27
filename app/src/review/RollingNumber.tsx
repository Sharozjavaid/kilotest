import { memo, useEffect } from 'react';
import { Platform, View, useWindowDimensions, type StyleProp, type TextStyle } from 'react-native';
import Animated, { Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { prefersReducedMotion } from '@/ui/a11y';
import { easings, timings } from '@/ui/motionPresets';
import { Text } from '@/ui/type';
import { rollOffset, rollSlots } from './lengthRoll';

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const [x1, y1, x2, y2] = easings[timings.numberRoll.easing];
const ease = Easing.bezier(x1, y1, x2, y2);
/** Dynamic Type for UI numbers stops at 1.4x (brief, section 5). */
const MAX_SCALE = 1.4;

/**
 * A number that rolls to its new value (the final length on Review): each digit column slides
 * on the UI thread, 240 ms `standard`; separators stay still; figures are tabular so nothing
 * shifts sideways. It changes only on discrete edits, never per frame. Reduce Motion: it jumps.
 * Web draws plain text (the browser suite reads it).
 */
export const RollingNumber = memo(function RollingNumber({
  text,
  style,
  lineHeight,
  accessibilityLabel,
  testID,
}: {
  text: string;
  style: StyleProp<TextStyle>;
  /** The style's line height, in points before Dynamic Type. */
  lineHeight: number;
  accessibilityLabel: string;
  testID?: string;
}) {
  const { fontScale } = useWindowDimensions();
  if (Platform.OS === 'web') {
    return (
      <Text style={[style, { fontVariant: ['tabular-nums'] }]} accessibilityLabel={accessibilityLabel} testID={testID}>
        {text}
      </Text>
    );
  }
  const h = lineHeight * Math.min(MAX_SCALE, Math.max(1, fontScale));
  const textStyle: StyleProp<TextStyle> = [style, { lineHeight: h, height: h, fontVariant: ['tabular-nums'] }];
  return (
    <View accessible accessibilityRole="text" accessibilityLabel={accessibilityLabel} testID={testID} style={{ flexDirection: 'row', height: h, overflow: 'hidden', alignSelf: 'flex-start' }}>
      {rollSlots(text).map((slot) =>
        slot.kind === 'digit' ? (
          <DigitColumn key={slot.key} digit={slot.digit} height={h} style={textStyle} />
        ) : (
          <Text key={slot.key} style={textStyle} maxFontSizeMultiplier={MAX_SCALE} importantForAccessibility="no">
            {slot.char}
          </Text>
        ),
      )}
    </View>
  );
});

function DigitColumn({ digit, height, style }: { digit: number; height: number; style: StyleProp<TextStyle> }) {
  const y = useSharedValue(rollOffset(digit, height));
  useEffect(() => {
    const to = rollOffset(digit, height);
    if (prefersReducedMotion()) y.value = to;
    else y.value = withTiming(to, { duration: timings.numberRoll.duration, easing: ease, reduceMotion: ReduceMotion.System });
  }, [digit, height, y]);
  const slide = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  return (
    <View style={{ height, overflow: 'hidden' }} importantForAccessibility="no-hide-descendants">
      <Animated.View style={slide}>
        {DIGITS.map((d) => (
          <Text key={d} style={style} maxFontSizeMultiplier={MAX_SCALE}>
            {d}
          </Text>
        ))}
      </Animated.View>
    </View>
  );
}
