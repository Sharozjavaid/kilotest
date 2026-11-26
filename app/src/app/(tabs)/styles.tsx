import { View } from 'react-native';
import { router } from 'expo-router';
import { Card, EmptyState, ErrorState, Header, PillButton, Screen, SkeletonRows, Text, color } from '@/ui';
import { GraphicThemeSwatch } from '@/styles/GraphicThemeSwatch';
import { settingsSummary } from '@/styles/styleForm';
import { useStyles } from '@/styles/useStyles';

/** Styles tab: saved presets of edit settings (GET /v1/styles). */
export default function StylesScreen() {
  const styles = useStyles();
  const list = styles.data ?? [];
  return (
    <Screen bottomInset={false} gap={12} refreshing={styles.isRefetching} onRefresh={() => void styles.refetch()} testID="styles">
      <Header title="Styles" noBack right={<PillButton variant="secondary" height={44} icon="plus" label="New style" onPress={() => router.push('/style/new')} testID="new-style" />} />
      <Text variant="secondary" tone="muted">
        A style is a set of edit settings. New batches and recordings start from your default style.
      </Text>
      {styles.isPending ? (
        <SkeletonRows count={3} />
      ) : styles.isError && !styles.data ? (
        <ErrorState error={styles.error} onRetry={() => void styles.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState icon="styles" title="No styles yet" body="Save the settings you use most, like a UGC ad with bold captions, and start every batch from them." action={{ label: 'Make a style', onPress: () => router.push('/style/new') }} />
      ) : (
        list.map((s) => (
          <Card key={s.id} onPress={() => router.push(`/style/${s.id}`)} accessibilityLabel={`${s.name}${s.isDefault ? ', default' : ''}. ${settingsSummary(s.settings)}`} accessibilityHint="Edit this style" testID={`style-${s.id}`}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <GraphicThemeSwatch themeId={s.settings.graphicThemeId} size="sm" />
              <View style={{ flex: 1, gap: 4 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text variant="bodyLg" numberOfLines={1} style={{ flexShrink: 1 }}>
                    {s.name}
                  </Text>
                  {s.isDefault ? (
                    <View style={{ backgroundColor: color.skyTint, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2 }}>
                      <Text variant="label" weight={600} tone="accent">
                        Default
                      </Text>
                    </View>
                  ) : null}
                </View>
                <Text variant="secondary" tone="muted" numberOfLines={2}>
                  {settingsSummary(s.settings)}
                </Text>
              </View>
            </View>
          </Card>
        ))
      )}
    </Screen>
  );
}
