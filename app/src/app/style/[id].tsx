import { useEffect, useState } from 'react';
import { Alert, Platform, TextInput, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { router, useLocalSearchParams } from 'expo-router';
import type { EditSettings } from '@kilo/edl';
import { errorMessage } from '@/api/errors';
import { MODES } from '@/components/SettingsControls';
import { GraphicThemePicker } from '@/styles/GraphicThemeSwatch';
import { CAPTION_STYLES } from '@/review/CaptionsControl';
import { formFromStyle, newStyleForm, styleNameError, toSaveRequest, withMode, type StyleForm } from '@/styles/styleForm';
import { useDeleteStyle, useSaveStyle, useStyles as useSavedStyles } from '@/styles/useStyles';
import { Card, ErrorState, LoadingBlock, PillButton, Row, Screen, SegmentedControl, Stepper, Text, Toggle, haptic, makeStyles, toast, typeStyle, useLayoutMotion, type ScreenHeaderConfig } from '@/ui';

const ios = Platform.OS === 'ios';

function SectionLabel({ children }: { children: string }) {
  return (
    <Text variant="secondary" weight={600} tone="muted" accessibilityRole="header" style={{ marginBottom: -6 }}>
      {children}
    </Text>
  );
}

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

const leave = () => (router.canGoBack() ? router.back() : router.replace('/styles'));

/**
 * Create (`/style/new`, a page sheet on iOS) or edit a saved style (pushed): inset grouped cards in
 * the iOS settings rhythm, Save in the navigation bar on iOS (a footer button elsewhere), Delete
 * at the bottom (design brief 4.10).
 */
export default function StyleEditorScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === 'new';
  const st = useStyles();
  const m = useLayoutMotion();
  const styles = useSavedStyles();
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

  const baseHeader: ScreenHeaderConfig = { title: isNew ? 'New style' : 'Edit style', close: isNew };
  if (styles.isPending || (!form && (isNew || existing))) {
    return (
      <Screen appearance="auto" header={baseHeader}>
        <LoadingBlock />
      </Screen>
    );
  }
  if (!form) {
    return (
      <Screen appearance="auto" header={{ ...baseHeader, title: 'Style' }}>
        <ErrorState error={styles.error ?? new Error('This style was deleted.')} onRetry={() => void styles.refetch()} />
      </Screen>
    );
  }

  const s = form.settings;
  const set = <K extends keyof EditSettings>(k: K, v: EditSettings[K]) => setForm({ ...form, settings: { ...s, [k]: v } });
  const nameError = styleNameError(form.name, list ?? [], isNew ? undefined : id);

  const onSave = () => {
    setShowErrors(true);
    if (nameError) {
      haptic('error');
      return;
    }
    save.mutate(
      { id: isNew ? undefined : id, body: toSaveRequest(form) },
      {
        onSuccess: () => {
          toast.success('Style saved', { haptic: true });
          leave();
        },
        onError: (e) => toast.error(`Couldn't save the style. ${errorMessage(e)}`),
      },
    );
  };
  const onDelete = () =>
    confirm(`Delete “${form.name}”?`, 'Videos already made with it are not changed.', () =>
      del.mutate(id, {
        onSuccess: () => {
          haptic('warning');
          leave();
        },
      }),
    );

  const error = save.isError || del.isError ? (
    <Text variant="secondary" tone="cut" center>
      {errorMessage(save.error ?? del.error)}
    </Text>
  ) : null;

  return (
    <Screen
      appearance="auto"
      gap={16}
      header={{
        ...baseHeader,
        // iOS: Save is a text button in the bar (accent). Elsewhere it is the footer's primary.
        actions: ios ? [{ label: 'Save', text: true, icon: 'check', onPress: onSave, disabled: save.isPending, testID: 'save-style' }] : undefined,
      }}
      footerGlass
      footer={
        ios ? undefined : (
          <>
            {error}
            <PillButton label={isNew ? 'Save style' : 'Save changes'} onPress={onSave} loading={save.isPending} testID="save-style" />
          </>
        )
      }
    >
      {ios ? error : null}
      <Card padding={0} paddingHorizontal={16}>
        <View style={st.nameRow}>
          <Text variant="secondary" tone="muted">
            Name
          </Text>
          <TextInput
            value={form.name}
            onChangeText={(name) => setForm({ ...form, name })}
            maxLength={60}
            accessibilityLabel="Style name"
            style={st.input}
            testID="style-name"
          />
        </View>
      </Card>
      {showErrors && nameError ? (
        <Text variant="label" tone="cut" style={{ marginTop: -8 }}>
          {nameError}
        </Text>
      ) : null}

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
      <Animated.View layout={m.listLayout}>
        <Card padding={0} paddingHorizontal={16}>
          <Row title="Burn in captions" subtitle="Off: add them in TikTok or Instagram" right={<Toggle value={s.captions} onValueChange={(v) => set('captions', v)} accessibilityLabel="Burn in captions" />} />
          {/* The caption-style row expands with a layout transition, never a jump. */}
          {s.captions ? (
            <Animated.View entering={m.listInsert} exiting={m.listRemove} style={{ paddingBottom: 14 }}>
              <SegmentedControl segments={CAPTION_STYLES} value={s.captionStyle} onChange={(v) => set('captionStyle', v)} accessibilityLabel="Caption style" />
            </Animated.View>
          ) : null}
        </Card>
      </Animated.View>

      <SectionLabel>B-roll and graphics</SectionLabel>
      <Animated.View layout={m.listLayout}>
      <Card padding={0} paddingHorizontal={16}>
        <Row title="Place your B-roll" subtitle="Clips you add to a video" right={<Toggle value={s.broll} onValueChange={(v) => set('broll', v)} accessibilityLabel="Place your B-roll" />} />
        <Row divider title="Stock B-roll" subtitle="Fill gaps from free-licence libraries" right={<Toggle value={s.stockBroll} onValueChange={(v) => set('stockBroll', v)} accessibilityLabel="Stock B-roll" />} />
        <Row divider title="Motion graphics" subtitle="Titles, lists, numbers and prices" right={<Toggle value={s.graphics} onValueChange={(v) => set('graphics', v)} accessibilityLabel="Motion graphics" />} />
        {s.graphics ? (
          <Animated.View entering={m.listInsert} exiting={m.listRemove} style={{ gap: 8, paddingBottom: 14 }}>
            <Text variant="label" tone="muted">
              Graphic theme
            </Text>
            <GraphicThemePicker value={s.graphicThemeId} onChange={(v) => set('graphicThemeId', v)} />
          </Animated.View>
        ) : null}
      </Card>
      </Animated.View>

      <Animated.View layout={m.listLayout} style={{ gap: 16 }}>
        <Card padding={0} paddingHorizontal={16}>
          <Row
            minHeight={60}
            title="Hook variations"
            subtitle={s.hookVariations === 1 ? 'One opening per video' : `Each video ships with ${s.hookVariations} openings`}
            right={<Stepper value={s.hookVariations} min={1} max={5} onChange={(n) => set('hookVariations', n)} noun="variations" />}
          />
        </Card>
        {!isNew ? <PillButton variant="text" destructive label="Delete style" onPress={onDelete} loading={del.isPending} testID="delete-style" /> : null}
      </Animated.View>
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52 },
  input: { ...typeStyle('bodyLg', 500), color: t.color.ink, flex: 1, minHeight: 52, paddingVertical: 0, textAlign: 'right' },
}));
