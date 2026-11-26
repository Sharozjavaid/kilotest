import { useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import type { CaptionStyle, Captions } from '@kilo/edl';
import { Card, PillButton, Row, SegmentedControl, Text, Toggle, color, radius, size } from '@/ui';

export const CAPTION_STYLES: ReadonlyArray<{ value: CaptionStyle; label: string; hint: string }> = [
  { value: 'clean', label: 'Clean', hint: 'White words on a soft shadow' },
  { value: 'bold', label: 'Bold', hint: 'Big heavy words, two lines at most' },
  { value: 'karaoke', label: 'Karaoke', hint: 'Each word lights up as you say it' },
];

/** "Captions off" / "Captions: Bold". */
export function captionsLabel(c: Captions): string {
  if (!c.enabled) return 'Captions off';
  return `Captions: ${CAPTION_STYLES.find((s) => s.value === c.style)?.label ?? c.style}`;
}

/** A compact chip in Review that opens a small sheet: burn-in on or off and the three styles. Edits `edl.captions`. */
export function CaptionsControl({ captions, onChange, disabled }: { captions: Captions; onChange: (c: Captions) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const hint = CAPTION_STYLES.find((s) => s.value === captions.style)?.hint ?? '';
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`${captionsLabel(captions)}. Change captions`}
        style={({ pressed }) => [styles.chip, pressed && { opacity: 0.7 }]}
        testID="captions-chip"
      >
        <View style={[styles.cc, captions.enabled && styles.ccOn]}>
          <Text variant="label" weight={700} tone={captions.enabled ? 'white' : 'muted'} style={{ fontSize: 10 }}>
            CC
          </Text>
        </View>
        <Text variant="secondary" weight={500}>
          {captionsLabel(captions)}
        </Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.scrim} onPress={() => setOpen(false)} accessibilityLabel="Close captions" accessibilityRole="button" />
        <View style={styles.sheetWrap} pointerEvents="box-none">
          <Card gap={14} style={styles.sheet}>
            <Text variant="titleSm">Captions</Text>
            <Row
              title="Burn in captions"
              subtitle="Off: add them in TikTok or Instagram"
              right={<Toggle value={captions.enabled} onValueChange={(enabled) => onChange({ ...captions, enabled })} accessibilityLabel="Burn in captions" testID="captions-toggle" />}
            />
            <View style={{ gap: 6, opacity: captions.enabled ? 1 : 0.5 }} pointerEvents={captions.enabled ? 'auto' : 'none'}>
              <SegmentedControl
                segments={CAPTION_STYLES}
                value={captions.style}
                onChange={(style) => onChange({ ...captions, style })}
                accessibilityLabel="Caption style"
              />
              <Text variant="label" tone="muted">
                {hint}
              </Text>
            </View>
            <PillButton label="Done" height={52} onPress={() => setOpen(false)} testID="captions-done" />
          </Card>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  chip: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: size.touch, alignSelf: 'flex-start', paddingRight: 8 },
  cc: { borderWidth: 1.5, borderColor: color.muted, borderRadius: 4, paddingHorizontal: 3, paddingVertical: 1 },
  ccOn: { backgroundColor: color.ink, borderColor: color.ink },
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(11,18,32,0.35)' },
  sheetWrap: { flex: 1, justifyContent: 'flex-end', padding: 12 },
  sheet: { backgroundColor: color.white, borderRadius: radius.card + 4 },
});
