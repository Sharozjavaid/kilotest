import { View } from 'react-native';
import { GRAPHIC_THEMES, getGraphicTheme } from '@kilo/edl';
import { PressableScale, Text, makeStyles, radius } from '@/ui';

/** A small card in a graphic theme's colours: background, "Aa" in the foreground, an accent bar. */
export function GraphicThemeSwatch({ themeId, size = 'md' }: { themeId: string; size?: 'sm' | 'md' }) {
  const styles = useStyles();
  const t = getGraphicTheme(themeId);
  const dims = size === 'sm' ? { width: 44, height: 56 } : { width: 72, height: 92 };
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

/** Pick one of GRAPHIC_THEMES: swatches with a 2pt `accent` ring on the selected one (brief 4.10). */
export function GraphicThemePicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const styles = useStyles();
  return (
    <View style={styles.row} accessibilityRole="radiogroup" accessibilityLabel="Graphic theme">
      {GRAPHIC_THEMES.map((t) => {
        const selected = t.id === value;
        return (
          <PressableScale
            key={t.id}
            onPress={() => onChange(t.id)}
            motion="chip"
            haptic={selected ? false : 'selection'}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            aria-checked={selected}
            accessibilityLabel={`${t.name} theme`}
            style={styles.option}
            testID={`theme-${t.id}`}
          >
            <View style={[styles.ring, selected && styles.ringOn]}>
              <GraphicThemeSwatch themeId={t.id} />
            </View>
            <Text variant="secondary" weight={selected ? 600 : 400} tone={selected ? 'ink' : 'muted'}>
              {t.name}
            </Text>
          </PressableScale>
        );
      })}
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  swatch: { borderRadius: radius.md, borderColor: t.color.hairline, alignItems: 'center', justifyContent: 'center', gap: 6, flexShrink: 0 },
  row: { flexDirection: 'row', gap: 12 },
  option: { alignItems: 'center', gap: 6, flex: 1 },
  ring: { padding: 3, borderRadius: radius.md + 5, borderWidth: 2, borderColor: 'transparent' },
  ringOn: { borderColor: t.color.accent },
}));
