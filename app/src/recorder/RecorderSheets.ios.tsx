import { BottomSheet, Button, Form, Group, Host, Image, Label, Picker, Section, Slider, Text, Toggle } from '@expo/ui/swift-ui';
import { disabled, pickerStyle, preferredColorScheme, presentationDetents, presentationDragIndicator, tag, tint } from '@expo/ui/swift-ui/modifiers';
import { useColors } from '@/ui/theme';
import type { RecorderPrefs } from './session';
import { SPEED_LABELS, type RecorderSheetsProps } from './RecorderSheets.types';

export type { RecorderSheetsProps } from './RecorderSheets.types';

/**
 * iOS: the recorder's sheets as native dark form sheets (SwiftUI, glass on iOS 26).
 * - Aa, medium detent: text size (segmented S / M / L), the scroll speed on a slider between a
 *   walking and a running figure, and the countdown switch. Each row shows its value.
 * - Lines, medium and large: every line with its state; tap one to go to it.
 */
export function RecorderSheets({ prefsOpen, linesOpen, session, onPrefs, onPick, onClosePrefs, onCloseLines }: RecorderSheetsProps) {
  const c = useColors();
  const prefs = session.prefs;
  const free = session.mode === 'free';
  return (
    <>
      <Host matchContents colorScheme="dark">
        <BottomSheet isPresented={prefsOpen} onIsPresentedChange={(v) => !v && onClosePrefs()}>
          <Group modifiers={[presentationDetents(['medium']), presentationDragIndicator('visible'), preferredColorScheme('dark'), tint(c.accent)]}>
            <Form>
              <Section title="Text size">
                <Picker<string> label="Text size" selection={prefs.textSize} onSelectionChange={(v) => onPrefs({ textSize: v as RecorderPrefs['textSize'] })} modifiers={[pickerStyle('segmented')]}>
                  {(['S', 'M', 'L'] as const).map((v) => (
                    <Text key={v} modifiers={[tag(v)]}>
                      {v}
                    </Text>
                  ))}
                </Picker>
              </Section>
              <Section title={`Scroll long lines: ${SPEED_LABELS[prefs.scrollSpeed]}`} footer={<Text>While you record, a long line rolls up after a moment.</Text>}>
                <Slider
                  value={prefs.scrollSpeed}
                  min={0}
                  max={3}
                  step={1}
                  minimumValueLabel={<Image systemName="figure.walk" />}
                  maximumValueLabel={<Image systemName="figure.run" />}
                  onValueChange={(v) => {
                    const next = Math.round(v) as RecorderPrefs['scrollSpeed'];
                    if (next !== prefs.scrollSpeed) onPrefs({ scrollSpeed: next });
                  }}
                />
              </Section>
              <Section>
                <Toggle label="Count down 3 seconds" isOn={prefs.countdown > 0} onIsOnChange={(on) => onPrefs({ countdown: on ? 3 : 0 })} />
              </Section>
            </Form>
          </Group>
        </BottomSheet>
      </Host>
      <Host matchContents colorScheme="dark">
        <BottomSheet isPresented={linesOpen} onIsPresentedChange={(v) => !v && onCloseLines()}>
          <Group modifiers={[presentationDetents(['medium', 'large']), presentationDragIndicator('visible'), preferredColorScheme('dark'), tint(c.accent)]}>
            <Form>
              <Section title={free ? 'Clips' : 'Lines'}>
                {session.lines.map((l, i) => {
                  const current = i === session.current;
                  const state = l.kept ? `Take ${l.kept.takeNumber}` : current ? 'Now' : 'To record';
                  return (
                    <Button key={l.key} onPress={() => onPick(i)} modifiers={current ? [disabled(true)] : undefined}>
                      <Label title={`${i + 1}. ${free ? `Clip ${i + 1}` : l.text} · ${state}`} systemImage={l.kept ? 'checkmark.circle.fill' : current ? 'record.circle' : 'circle'} />
                    </Button>
                  );
                })}
              </Section>
            </Form>
          </Group>
        </BottomSheet>
      </Host>
    </>
  );
}
