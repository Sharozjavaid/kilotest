import { BottomSheet, Form, Group, Host, Picker, Section, Text, Toggle } from '@expo/ui/swift-ui';
import { disabled, pickerStyle, presentationDetents, presentationDragIndicator, tag, tint } from '@expo/ui/swift-ui/modifiers';
import { useTheme } from '@/ui/theme';
import { CAPTION_STYLES, captionHint, type CaptionsSheetProps } from './captions';

/**
 * iOS: a native form sheet at the medium detent with the grabber (SwiftUI `BottomSheet`, glass
 * on iOS 26): the burn-in switch, then the three styles as a segmented picker with a hint.
 * Swipe down or tap outside to close.
 */
export function CaptionsSheet({ open, captions, onChange, onClose }: CaptionsSheetProps) {
  const t = useTheme();
  return (
    <Host matchContents colorScheme={t.scheme}>
      <BottomSheet isPresented={open} onIsPresentedChange={(v) => !v && onClose()}>
        <Group modifiers={[presentationDetents(['medium']), presentationDragIndicator('visible'), tint(t.color.accent)]}>
          <Form>
            <Section title="Captions" footer={<Text>Off: add them in TikTok or Instagram</Text>}>
              <Toggle label="Burn in captions" isOn={captions.enabled} onIsOnChange={(enabled) => onChange({ ...captions, enabled })} />
            </Section>
            <Section title="Style" footer={<Text>{captionHint(captions.style)}</Text>}>
              <Picker<string>
                label="Caption style"
                selection={captions.style}
                onSelectionChange={(v) => onChange({ ...captions, style: v as typeof captions.style })}
                modifiers={[pickerStyle('segmented'), disabled(!captions.enabled)]}
              >
                {CAPTION_STYLES.map((s) => (
                  <Text key={s.value} modifiers={[tag(s.value)]}>
                    {s.label}
                  </Text>
                ))}
              </Picker>
            </Section>
          </Form>
        </Group>
      </BottomSheet>
    </Host>
  );
}
