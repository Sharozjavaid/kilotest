import type { ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PillButton } from '@/ui/PillButton';
import { PressableScale } from '@/ui/PressableScale';
import { SegmentedControl } from '@/ui/controls';
import { Text } from '@/ui/type';
import { ThemeScope, makeStyles, useColors } from '@/ui/theme';
import type { RecorderPrefs } from './session';
import { SPEED_LABELS, type RecorderSheetsProps } from './RecorderSheets.types';

export type { RecorderSheetsProps } from './RecorderSheets.types';

const useStyles = makeStyles((t) => ({
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.4)' },
  wrap: { flex: 1, justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#141A26', borderTopLeftRadius: 28, borderTopRightRadius: 28, borderWidth: 1, borderColor: t.color.hairline, padding: 20, gap: 16, maxHeight: '85%', width: '100%', maxWidth: 560, alignSelf: 'center' },
  grabber: { alignSelf: 'center', width: 36, height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.2)', marginTop: -8 },
  lineRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: 12, borderRadius: 14, borderWidth: 1, borderColor: t.color.hairline },
  dot: { width: 10, height: 10, borderRadius: 5 },
}));

/**
 * Android and web: the recorder's Aa and Lines sheets as Kilo's dark bottom sheets. iOS draws
 * native SwiftUI sheets (`RecorderSheets.ios.tsx`).
 */
export function RecorderSheets(p: RecorderSheetsProps) {
  return (
    <>
      <Sheet visible={p.prefsOpen} title="Script and recording" onClose={p.onClosePrefs}>
        <Prefs prefs={p.session.prefs} onChange={p.onPrefs} />
      </Sheet>
      <Sheet visible={p.linesOpen} title={p.session.mode === 'free' ? 'Clips' : 'Lines'} onClose={p.onCloseLines}>
        <Lines {...p} />
      </Sheet>
    </>
  );
}

function Sheet({ visible, title, onClose, children }: { visible: boolean; title: string; onClose: () => void; children: ReactNode }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <ThemeScope appearance="dark">
        <SheetBody title={title} onClose={onClose}>
          {children}
        </SheetBody>
      </ThemeScope>
    </Modal>
  );
}

function SheetBody({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const s = useStyles();
  const insets = useSafeAreaInsets();
  return (
    <>
      <Pressable style={s.scrim} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
      <View style={s.wrap} pointerEvents="box-none">
        <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 20) }]}>
          <View style={s.grabber} />
          <Text variant="titleSm" accessibilityRole="header">
            {title}
          </Text>
          {children}
          <PillButton label="Done" height={52} onPress={onClose} testID="sheet-done" />
        </View>
      </View>
    </>
  );
}

function Prefs({ prefs, onChange }: { prefs: RecorderPrefs; onChange: (p: Partial<RecorderPrefs>) => void }) {
  return (
    <>
      <View style={{ gap: 6 }}>
        <Text variant="secondary" tone="muted">
          Text size
        </Text>
        <SegmentedControl
          segments={[
            { value: 'S', label: 'Small' },
            { value: 'M', label: 'Medium' },
            { value: 'L', label: 'Large' },
          ]}
          value={prefs.textSize}
          onChange={(textSize) => onChange({ textSize })}
          accessibilityLabel="Text size"
        />
      </View>
      <View style={{ gap: 6 }}>
        <Text variant="secondary" tone="muted">
          Scroll long lines while recording
        </Text>
        <SegmentedControl
          segments={([0, 1, 2, 3] as const).map((v) => ({ value: String(v) as '0' | '1' | '2' | '3', label: SPEED_LABELS[v] }))}
          value={String(prefs.scrollSpeed) as '0' | '1' | '2' | '3'}
          onChange={(v) => onChange({ scrollSpeed: Number(v) as RecorderPrefs['scrollSpeed'] })}
          accessibilityLabel="Auto-scroll speed"
        />
      </View>
      <View style={{ gap: 6 }}>
        <Text variant="secondary" tone="muted">
          Countdown before recording
        </Text>
        <SegmentedControl
          segments={[
            { value: '0', label: 'Off' },
            { value: '3', label: '3 seconds' },
          ]}
          value={String(prefs.countdown) as '0' | '3'}
          onChange={(v) => onChange({ countdown: Number(v) as RecorderPrefs['countdown'] })}
          accessibilityLabel="Countdown"
        />
      </View>
    </>
  );
}

function Lines({ session, onPick }: RecorderSheetsProps) {
  const s = useStyles();
  const c = useColors();
  const free = session.mode === 'free';
  return (
    <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ gap: 6 }}>
      {session.lines.map((l, i) => {
        const current = i === session.current;
        return (
          <PressableScale
            key={l.key}
            onPress={() => onPick(i)}
            disabled={current}
            motion="row"
            accessibilityRole="button"
            accessibilityLabel={`${free ? 'Clip' : 'Line'} ${i + 1}${l.kept ? `, kept take ${l.kept.takeNumber}` : ''}${current ? ', recording now' : ''}`}
            style={[s.lineRow, current && { borderColor: c.ink }]}
            testID={`jump-${i}`}
          >
            <View style={[s.dot, { backgroundColor: l.kept ? c.accent : current ? c.ink : c.track }]} />
            <Text variant="body" style={{ flex: 1 }} numberOfLines={2}>
              {free ? `Clip ${i + 1}` : l.text}
            </Text>
            <Text variant="label" tone="muted">
              {l.kept ? `Take ${l.kept.takeNumber}` : current ? 'Now' : ''}
            </Text>
          </PressableScale>
        );
      })}
    </ScrollView>
  );
}
