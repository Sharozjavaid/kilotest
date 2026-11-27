import { View } from 'react-native';
import Animated from 'react-native-reanimated';
import { router } from 'expo-router';
import { Card, EmptyState, ErrorState, Screen, SkeletonRows, Text, makeStyles, useLayoutMotion } from '@/ui';
import { GraphicThemeSwatch } from '@/styles/GraphicThemeSwatch';
import { settingsSummary } from '@/styles/styleForm';
import { useStyles as useSavedStyles } from '@/styles/useStyles';

const newStyle = () => router.push('/style/new');

/**
 * Styles tab (design brief 4.9): saved presets of edit settings (GET /v1/styles). Large title
 * with a glass + on iOS; content cards; a new style arrives with `listInsert`, a deleted one
 * leaves with `listRemove`.
 */
export default function StylesScreen() {
  const s = useStyles();
  const m = useLayoutMotion();
  const styles = useSavedStyles();
  const list = styles.data ?? [];
  return (
    <Screen
      appearance="auto"
      bottomInset={false}
      gap={12}
      refreshing={styles.isRefetching}
      onRefresh={() => void styles.refetch()}
      testID="styles"
      header={{ title: 'Styles', large: true, noBack: true, actions: [{ label: 'New style', icon: 'plus', onPress: newStyle, testID: 'new-style' }] }}
    >
      <Text variant="body" tone="muted">
        A style is a set of edit settings. New batches and recordings start from your default style.
      </Text>
      {styles.isPending ? (
        <SkeletonRows count={3} />
      ) : styles.isError && !styles.data ? (
        <ErrorState error={styles.error} onRetry={() => void styles.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState
          icon="styles"
          title="No styles yet"
          body="Save the settings you use most, like a UGC ad with bold captions, and start every batch from them."
          action={{ label: 'Make a style', onPress: newStyle }}
        />
      ) : (
        list.map((st) => (
          <Animated.View key={st.id} entering={m.listInsert} exiting={m.listRemove} layout={m.listLayout}>
            <Card onPress={() => router.push(`/style/${st.id}`)} accessibilityLabel={`${st.name}${st.isDefault ? ', default' : ''}. ${settingsSummary(st.settings)}`} accessibilityHint="Edit this style" testID={`style-${st.id}`}>
              <View style={s.row}>
                <GraphicThemeSwatch themeId={st.settings.graphicThemeId} size="sm" />
                <View style={s.text}>
                  <View style={s.nameRow}>
                    <Text variant="bodyLg" numberOfLines={1} style={s.name}>
                      {st.name}
                    </Text>
                    {st.isDefault ? (
                      <View style={s.defaultChip}>
                        <Text variant="label" weight={600} tone="accent">
                          Default
                        </Text>
                      </View>
                    ) : null}
                  </View>
                  <Text variant="secondary" tone="muted" numberOfLines={2}>
                    {settingsSummary(st.settings)}
                  </Text>
                </View>
              </View>
            </Card>
          </Animated.View>
        ))
      )}
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  text: { flex: 1, gap: 4 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { flexShrink: 1 },
  defaultChip: { backgroundColor: t.color.chipOn, borderRadius: 10, height: 20, paddingHorizontal: 8, justifyContent: 'center' },
}));
