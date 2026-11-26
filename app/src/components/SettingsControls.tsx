import { View } from 'react-native';
import { MODE_PRESETS, type EditSettings, type Mode } from '@kilo/edl';
import { Card, Row, SegmentedControl, Stepper, Text, Toggle } from '@/ui';

/**
 * The edit settings controls of the New batch screen (mock-up `NewBatch`), shared
 * with the recorder's confirm step and the style editor.
 */

export const MODES = (Object.keys(MODE_PRESETS) as Mode[]).map((m) => ({ value: m, label: MODE_PRESETS[m].label }));

type Set = <K extends keyof EditSettings>(k: K, v: EditSettings[K]) => void;

/** "Kind of video": switching mode loads that mode's preset. */
export function ModeControl({ settings, onChange }: { settings: EditSettings; onChange: (s: EditSettings) => void }) {
  return (
    <View style={{ gap: 6 }}>
      <Text variant="secondary" tone="muted">
        Kind of video
      </Text>
      <SegmentedControl segments={MODES} value={settings.mode} onChange={(mode) => onChange({ ...MODE_PRESETS[mode].settings, graphicThemeId: settings.graphicThemeId })} accessibilityLabel="Kind of video" />
    </View>
  );
}

export function EditSwitches({ settings, set }: { settings: EditSettings; set: Set }) {
  return (
    <Card padding={0} paddingHorizontal={16}>
      <Row minHeight={52} title="Cut dead air" right={<Toggle value={settings.cutDeadAir} onValueChange={(v) => set('cutDeadAir', v)} accessibilityLabel="Cut dead air" />} />
      <Row divider title="Remove retakes" subtitle="Keeps the last good take of each line" right={<Toggle value={settings.removeRetakes} onValueChange={(v) => set('removeRetakes', v)} accessibilityLabel="Remove retakes" />} />
      <Row divider title="Zooms and transitions" subtitle="Punch in on cuts, slow pan on photos" right={<Toggle value={settings.zoomAndTransitions} onValueChange={(v) => set('zoomAndTransitions', v)} accessibilityLabel="Zooms and transitions" />} />
      <Row divider title="Burn in captions" subtitle="Off: add them in TikTok or Instagram" right={<Toggle value={settings.captions} onValueChange={(v) => set('captions', v)} accessibilityLabel="Burn in captions" />} />
    </Card>
  );
}

export function HookVariations({ settings, set, perVideo = 'Each video ships with' }: { settings: EditSettings; set: Set; perVideo?: string }) {
  return (
    <Card padding={0} paddingHorizontal={16} flat>
      <Row
        minHeight={60}
        title="Hook variations"
        subtitle={settings.hookVariations === 1 ? 'One opening per video' : `${perVideo} ${settings.hookVariations} openings`}
        right={<Stepper value={settings.hookVariations} min={1} max={5} onChange={(n) => set('hookVariations', n)} noun="variations" />}
      />
    </Card>
  );
}
