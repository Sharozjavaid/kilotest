import { useEffect, useState } from 'react';
import { Alert, Platform, StyleSheet, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import type { EditSettings } from '@kilo/edl';
import { errorMessage } from '@/api/errors';
import { MODES } from '@/components/SettingsControls';
import { GraphicThemePicker } from '@/styles/GraphicThemeSwatch';
import { CAPTION_STYLES } from '@/review/CaptionsControl';
import { formFromStyle, newStyleForm, styleNameError, toSaveRequest, withMode, type StyleForm } from '@/styles/styleForm';
import { useDeleteStyle, useSaveStyle, useStyles } from '@/styles/useStyles';
import { Card, ErrorState, Header, LoadingBlock, PillButton, Row, Screen, SectionLabel, SegmentedControl, Stepper, Text, Toggle, color, radius, typeStyle } from '@/ui';

function confirm(title: string, message: string, onYes: () => void) {
  if (Platform.OS === 'web') {
    if ((globalThis as { confirm?: (m: string) => boolean }).confirm?.(`${title}\n\n${message}`) ?? true) onYes();
    return;
  }
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: onYes },
  ]);
}

/** Create (`/style/new`) or edit a saved style. */
export default function StyleEditorScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === 'new';
  const styles = useStyles();
  const save = useSaveStyle();
  const del = useDeleteStyle();
  const [form, setForm] = useState<StyleForm | null>(null);
  const [showErrors, setShowErrors] = useState(false);

  const list = styles.data;
  const existing = list?.find((s) => s.id === id);
  useEffect(() => {
    if (form || !list) return;
    if (isNew) setForm(newStyleForm(list));
    else if (existing) setForm(formFromStyle(existing));
  }, [list, existing, isNew, form]);

  if (styles.isPending || (!form && (isNew || existing))) {
    return (
      <Screen>
        <Header title={isNew ? 'New style' : 'Style'} />
        <LoadingBlock />
      </Screen>
    );
  }
  if (!form) {
    return (
      <Screen>
        <Header title="Style" />
        <ErrorState error={styles.error ?? new Error('This style was deleted.')} onRetry={() => void styles.refetch()} />
      </Screen>
    );
  }

  const s = form.settings;
  const set = <K extends keyof EditSettings>(k: K, v: EditSettings[K]) => setForm({ ...form, settings: { ...s, [k]: v } });
  const nameError = styleNameError(form.name, list ?? [], isNew ? undefined : id);

  const onSave = () => {
    setShowErrors(true);
    if (nameError) return;
    save.mutate(
      { id: isNew ? undefined : id, body: toSaveRequest(form) },
      { onSuccess: () => (router.canGoBack() ? router.back() : router.replace('/styles')) },
    );
  };
  const onDelete = () =>
    confirm(`Delete “${form.name}”?`, 'Videos already made with it are not changed.', () =>
      del.mutate(id, { onSuccess: () => (router.canGoBack() ? router.back() : router.replace('/styles')) }),
    );

  return (
    <Screen
      gap={12}
      footer={
        <>
          {save.isError || del.isError ? (
            <Text variant="secondary" tone="cut" center>
              {errorMessage(save.error ?? del.error)}
            </Text>
          ) : null}
          <PillButton label={isNew ? 'Save style' : 'Save changes'} onPress={onSave} loading={save.isPending} testID="save-style" />
          {!isNew ? <PillButton variant="text" destructive label="Delete style" onPress={onDelete} loading={del.isPending} testID="delete-style" /> : null}
        </>
      }
    >
      <Header title={isNew ? 'New style' : 'Edit style'} />

      <View style={{ gap: 6 }}>
        <Text variant="secondary" tone="muted">
          Name
        </Text>
        <TextInput
          value={form.name}
          onChangeText={(name) => setForm({ ...form, name })}
          maxLength={60}
          accessibilityLabel="Style name"
          style={[st.input, showErrors && nameError ? { borderColor: color.cut } : null]}
          testID="style-name"
        />
        {showErrors && nameError ? (
          <Text variant="label" tone="cut">
            {nameError}
          </Text>
        ) : null}
      </View>

      <Card padding={0} paddingHorizontal={16}>
        <Row title="Use for new batches" subtitle="New batches and recordings start from this style" right={<Toggle value={form.isDefault} onValueChange={(isDefault) => setForm({ ...form, isDefault })} accessibilityLabel="Use for new batches" testID="style-default" />} />
      </Card>

      <View style={{ gap: 6 }}>
        <Text variant="secondary" tone="muted">
          Kind of video
        </Text>
        <SegmentedControl segments={MODES} value={s.mode} onChange={(m) => setForm({ ...form, settings: withMode(s, m) })} accessibilityLabel="Kind of video" />
      </View>

      <View style={{ gap: 6 }}>
        <Text variant="secondary" tone="muted">
          Pacing
        </Text>
        <SegmentedControl
          segments={[
            { value: 'natural', label: 'Natural' },
            { value: 'tight', label: 'Tight' },
          ]}
          value={s.pacing}
          onChange={(p) => set('pacing', p)}
          accessibilityLabel="Pacing"
        />
      </View>

      <SectionLabel>Cutting</SectionLabel>
      <Card padding={0} paddingHorizontal={16}>
        <Row minHeight={52} title="Cut dead air" right={<Toggle value={s.cutDeadAir} onValueChange={(v) => set('cutDeadAir', v)} accessibilityLabel="Cut dead air" />} />
        <Row divider title="Remove retakes" subtitle="Keeps the last good take of each line" right={<Toggle value={s.removeRetakes} onValueChange={(v) => set('removeRetakes', v)} accessibilityLabel="Remove retakes" />} />
        <Row divider title="Remove filler words" subtitle="Um, uh and the like" right={<Toggle value={s.removeFillers} onValueChange={(v) => set('removeFillers', v)} accessibilityLabel="Remove filler words" />} />
        <Row divider title="Zooms and transitions" subtitle="Punch in on cuts, slow pan on photos" right={<Toggle value={s.zoomAndTransitions} onValueChange={(v) => set('zoomAndTransitions', v)} accessibilityLabel="Zooms and transitions" />} />
      </Card>

      <SectionLabel>Captions</SectionLabel>
      <Card padding={0} paddingHorizontal={16}>
        <Row title="Burn in captions" subtitle="Off: add them in TikTok or Instagram" right={<Toggle value={s.captions} onValueChange={(v) => set('captions', v)} accessibilityLabel="Burn in captions" />} />
        {s.captions ? (
          <View style={{ paddingBottom: 14 }}>
            <SegmentedControl segments={CAPTION_STYLES} value={s.captionStyle} onChange={(v) => set('captionStyle', v)} accessibilityLabel="Caption style" />
          </View>
        ) : null}
      </Card>

      <SectionLabel>B-roll and graphics</SectionLabel>
      <Card padding={0} paddingHorizontal={16}>
        <Row title="Place your B-roll" subtitle="Clips you add to a video" right={<Toggle value={s.broll} onValueChange={(v) => set('broll', v)} accessibilityLabel="Place your B-roll" />} />
        <Row divider title="Stock B-roll" subtitle="Fill gaps from free-licence libraries" right={<Toggle value={s.stockBroll} onValueChange={(v) => set('stockBroll', v)} accessibilityLabel="Stock B-roll" />} />
        <Row divider title="Motion graphics" subtitle="Titles, lists, numbers and prices" right={<Toggle value={s.graphics} onValueChange={(v) => set('graphics', v)} accessibilityLabel="Motion graphics" />} />
        {s.graphics ? (
          <View style={{ gap: 8, paddingBottom: 14 }}>
            <Text variant="label" tone="muted">
              Graphic theme
            </Text>
            <GraphicThemePicker value={s.graphicThemeId} onChange={(v) => set('graphicThemeId', v)} />
          </View>
        ) : null}
      </Card>

      <Card padding={0} paddingHorizontal={16} flat>
        <Row
          minHeight={60}
          title="Hook variations"
          subtitle={s.hookVariations === 1 ? 'One opening per video' : `Each video ships with ${s.hookVariations} openings`}
          right={<Stepper value={s.hookVariations} min={1} max={5} onChange={(n) => set('hookVariations', n)} noun="variations" />}
        />
      </Card>
    </Screen>
  );
}

const st = StyleSheet.create({
  input: {
    ...typeStyle('bodyLg', 500),
    color: color.ink,
    minHeight: 52,
    borderRadius: radius.row,
    borderWidth: 1,
    borderColor: color.outline,
    backgroundColor: color.white,
    paddingHorizontal: 14,
  },
});
