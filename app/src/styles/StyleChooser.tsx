import { useEffect, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import type { EditSettings } from '@kilo/edl';
import { Icon, Text, color, radius, size } from '@/ui';
import { matchingStyle, nextStyleName, startingSettings, toSaveRequest } from './styleForm';
import { useSaveStyle, useStyles } from './useStyles';

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

/** A row of style chips: tap one to load its settings; "Save as style" keeps the current settings. */
export function StyleChooser({ settings, onPick }: { settings: EditSettings; onPick: (s: EditSettings) => void }) {
  const styles = useStyles();
  const save = useSaveStyle();
  const list = styles.data ?? [];
  const current = matchingStyle(list, settings);

  const saveCurrent = () => {
    save.mutate({ body: toSaveRequest({ name: nextStyleName(list), settings, isDefault: list.length === 0 }) });
  };

  if (!styles.data) return null;
  return (
    <View style={{ gap: 6 }}>
      <Text variant="secondary" tone="muted">
        Style
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.row} accessibilityRole="radiogroup" accessibilityLabel="Style">
        {list.map((st) => {
          const selected = current?.id === st.id;
          return (
            <Pressable
              key={st.id}
              onPress={() => onPick(st.settings)}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
            aria-checked={selected}
              accessibilityLabel={`${st.name}${st.isDefault ? ', default' : ''}`}
              style={({ pressed }) => [s.chip, selected && s.chipOn, pressed && { opacity: 0.7 }]}
              testID={`style-chip-${st.id}`}
            >
              <Text variant="secondary" weight={selected ? 600 : 500} tone={selected ? 'white' : 'ink'} numberOfLines={1}>
                {st.name}
              </Text>
            </Pressable>
          );
        })}
        {!current ? (
          <Pressable onPress={saveCurrent} disabled={save.isPending} accessibilityRole="button" accessibilityLabel="Save these settings as a style" style={({ pressed }) => [s.chip, s.chipGhost, pressed && { opacity: 0.7 }]} testID="save-as-style">
            <Icon name="plus" size={16} color={color.accent} />
            <Text variant="secondary" weight={600} tone="accent">
              {save.isPending ? 'Saving…' : 'Save as style'}
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  row: { gap: 8, paddingRight: 4 },
  chip: {
    minHeight: size.touch,
    paddingHorizontal: 16,
    borderRadius: size.touch / 2,
    borderWidth: 1,
    borderColor: color.hairline,
    backgroundColor: color.surface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: 200,
  },
  chipOn: { backgroundColor: color.ink, borderColor: color.ink },
  chipGhost: { borderStyle: 'dashed', borderColor: color.dropBorder, backgroundColor: color.dropFill, borderRadius: radius.card },
});
