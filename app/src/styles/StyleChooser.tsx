import { useEffect, useRef } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import type { EditSettings } from '@kilo/edl';
import { Card, Chip, PillButton, Row, Text, makeStyles, space } from '@/ui';
import { matchingStyle, nextStyleName, startingSettings, toSaveRequest } from './styleForm';
import { useSaveStyle, useStyles } from './useStyles';
import { StyleMenu } from './StyleMenu';

/**
 * Loads the default style into `setSettings` once styles arrive, unless the creator
 * already changed something. Returns a function to call on any manual change.
 */
export function useStartingSettings(setSettings: (s: EditSettings) => void): () => void {
  const styles = useStyles();
  const touched = useRef(false);
  const applied = useRef(false);
  useEffect(() => {
    if (applied.current || touched.current || !styles.data) return;
    applied.current = true;
    setSettings(startingSettings(styles.data));
  }, [styles.data, setSettings]);
  return () => {
    touched.current = true;
  };
}

const useChooserStyles = makeStyles(() => ({
  row: { gap: 8, paddingHorizontal: space.gutter, paddingVertical: 2 },
  scroll: { marginHorizontal: -space.gutter },
}));

/**
 * The batch's style. iOS: a "Style" row whose value is a native menu of the saved styles (design
 * brief 4.4). Android and web: a row of style chips. Picking one loads its settings; "Save as
 * style" keeps settings that match none.
 */
export function StyleChooser({ settings, onPick }: { settings: EditSettings; onPick: (s: EditSettings) => void }) {
  const s = useChooserStyles();
  const styles = useStyles();
  const save = useSaveStyle();
  const list = styles.data ?? [];
  const current = matchingStyle(list, settings);

  const saveCurrent = () => {
    if (save.isPending) return;
    save.mutate({ body: toSaveRequest({ name: nextStyleName(list), settings, isDefault: list.length === 0 }) });
  };

  if (!styles.data) return null;

  if (Platform.OS === 'ios') {
    return (
      <Card padding={0} paddingHorizontal={16}>
        <Row
          title="Style"
          subtitle={current ? undefined : 'These settings are your own'}
          right={list.length ? <StyleMenu styles={list} currentId={current?.id ?? null} onPick={(id) => {
            const st = list.find((x) => x.id === id);
            if (st) onPick(st.settings);
          }} /> : <Text variant="body" tone="muted">None saved</Text>}
        />
        {!current ? (
          <View style={{ alignItems: 'flex-start', marginLeft: -16 }}>
            <PillButton variant="text" icon="plus" label={save.isPending ? 'Saving…' : 'Save as style'} onPress={saveCurrent} disabled={save.isPending} accessibilityLabel="Save these settings as a style" testID="save-as-style" />
          </View>
        ) : null}
      </Card>
    );
  }

  return (
    <View style={{ gap: 6 }}>
      <Text variant="secondary" tone="muted">
        Style
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.scroll} contentContainerStyle={s.row} accessibilityLabel="Style">
        {list.map((st) => (
          <Chip
            key={st.id}
            label={st.name}
            selected={current?.id === st.id}
            onPress={() => onPick(st.settings)}
            accessibilityLabel={`${st.name}${st.isDefault ? ', default' : ''}`}
            testID={`style-chip-${st.id}`}
          />
        ))}
        {!current ? (
          <Chip label={save.isPending ? 'Saving…' : 'Save as style'} icon="plus" onPress={saveCurrent} accessibilityLabel="Save these settings as a style" testID="save-as-style" />
        ) : null}
      </ScrollView>
    </View>
  );
}
