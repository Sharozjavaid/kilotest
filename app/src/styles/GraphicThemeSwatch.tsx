import { Pressable, StyleSheet, View } from 'react-native';
import { GRAPHIC_THEMES, getGraphicTheme } from '@kilo/edl';
import { Text, color, radius } from '@/ui';

/** A small card in a graphic theme's colours: background, "Aa" in the foreground, an accent bar. */
export function GraphicThemeSwatch({ themeId, size = 'md' }: { themeId: string; size?: 'sm' | 'md' }) {
  const t = getGraphicTheme(themeId);
  const dims = size === 'sm' ? { width: 40, height: 52 } : { width: 72, height: 92 };
  return (
    <View
      style={[styles.swatch, dims, { backgroundColor: t.background, borderWidth: t.background.toUpperCase() === '#FFFFFF' ? 1 : 0 }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text weight={700} style={{ color: t.foreground, fontSize: size === 'sm' ? 15 : 24, letterSpacing: -0.5 }}>
        Aa
      </Text>
      <View style={{ width: size === 'sm' ? 14 : 24, height: size === 'sm' ? 3 : 4, borderRadius: 2, backgroundColor: t.accent }} />
    </View>
  );
}

/** Pick one of GRAPHIC_THEMES. */
export function GraphicThemePicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  return (
    <View style={styles.row} accessibilityRole="radiogroup" accessibilityLabel="Graphic theme">
      {GRAPHIC_THEMES.map((t) => {
        const selected = t.id === value;
        return (
          <Pressable
            key={t.id}
            onPress={() => onChange(t.id)}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            aria-checked={selected}
            accessibilityLabel={`${t.name} theme`}
            style={({ pressed }) => [styles.option, pressed && { opacity: 0.7 }]}
            testID={`theme-${t.id}`}
          >
            <View style={[styles.ring, selected && styles.ringOn]}>
              <GraphicThemeSwatch themeId={t.id} />
            </View>
            <Text variant="secondary" weight={selected ? 600 : 400} tone={selected ? 'ink' : 'muted'}>
              {t.name}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  swatch: { borderRadius: radius.md, borderColor: color.hairline, alignItems: 'center', justifyContent: 'center', gap: 6, flexShrink: 0 },
  row: { flexDirection: 'row', gap: 12 },
  option: { alignItems: 'center', gap: 6, flex: 1 },
  ring: { padding: 3, borderRadius: radius.md + 4, borderWidth: 2, borderColor: 'transparent' },
  ringOn: { borderColor: color.accent },
});
