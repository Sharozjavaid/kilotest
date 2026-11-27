import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Platform, TextInput, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { router, useFocusEffect } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { MODE_PRESETS, type EditSettings } from '@kilo/edl';
import { getApi, getMockApi } from '@/api/client';
import { errorMessage } from '@/api/errors';
import { keys } from '@/api/queries';
import { getUploadQueue } from '@/uploads/UploadManager';
import { pickFromLibrary, sampleFiles } from '@/newBatch/picker';
import { EditSwitches, HookVariations, ModeControl } from '@/components/SettingsControls';
import { StyleChooser, useStartingSettings } from '@/styles/StyleChooser';
import { buildBatchRequest, defaultTitle, keptCount, recordingUploadJobs, resumeRecording, setTitle, type BrollFile } from '@/recorder/session';
import { endSession, loadRecorder, updateRecorder, useRecorder } from '@/recorder/store';
import { formatDuration, plural } from '@/lib/format';
import { Card, PillButton, Screen, Skeleton, SymbolIcon, Text, haptic, makeStyles, motionHaptics, radius, toast, typeStyle, useColors, useLayoutMotion } from '@/ui';

function notify(title: string, message: string) {
  if (Platform.OS === 'web') (globalThis as { alert?: (m: string) => void }).alert?.(`${title}\n\n${message}`);
  else Alert.alert(title, message);
}

const useStyles = makeStyles((t) => ({
  input: {
    ...typeStyle('bodyLg', 500),
    color: t.color.ink,
    minHeight: 52,
    borderRadius: radius.row,
    borderWidth: 1,
    borderColor: t.color.outline,
    backgroundColor: t.color.fill,
    paddingHorizontal: 14,
  },
  summary: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  take: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingVertical: 8 },
  divider: { borderTopWidth: 1, borderTopColor: t.color.hairline },
  drop: {
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: t.color.dropBorder,
    backgroundColor: t.color.dropFill,
    borderRadius: radius.card,
    paddingVertical: 12,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
}));

/** Record with script, step 3 (design brief 4.15): the takes and the edit settings, then create the batch. */
export default function RecordFinishScreen() {
  const s = useStyles();
  const c = useColors();
  const m = useLayoutMotion();
  const qc = useQueryClient();
  const { loaded, session } = useRecorder();
  const [settings, setSettings] = useState<EditSettings>(MODE_PRESETS.general.settings);
  const touched = useStartingSettings(setSettings);
  const [broll, setBroll] = useState<BrollFile[]>([]);
  const [submitting, setSubmitting] = useState(false);
  /** Set once the batch is created: ending the session must not send this screen back to /record. */
  const leaving = useRef(false);

  useEffect(() => {
    void loadRecorder();
  }, []);
  // Only the focused screen redirects: after Finish, screens still under the stack must not navigate.
  useFocusEffect(
    useCallback(() => {
      if (loaded && !session && !leaving.current) router.replace('/record');
    }, [loaded, session]),
  );

  const back = () => {
    updateRecorder((st) => resumeRecording(st));
    if (router.canGoBack()) router.back();
    else router.replace('/record/camera');
  };

  if (!loaded || !session) {
    return (
      <Screen appearance="auto" header={{ title: 'Ready to edit', onBack: back }}>
        <View style={{ gap: 12 }} accessibilityLabel="Loading" accessibilityRole="progressbar">
          <Skeleton height={52} radius={14} />
          <Skeleton height={160} radius={20} />
        </View>
      </Screen>
    );
  }

  const change = (next: EditSettings) => {
    touched();
    setSettings(next);
  };
  const set = <K extends keyof EditSettings>(k: K, v: EditSettings[K]) => change({ ...settings, [k]: v });

  const free = session.mode === 'free';
  const kept = keptCount(session);
  const total = session.lines.reduce((n, l) => n + (l.kept?.durationSec ?? 0), 0);
  const title = session.title;
  const missing = free ? [] : session.lines.map((l, i) => ({ l, i })).filter(({ l }) => !l.kept);
  const meta = `${plural(kept, 'clip')} · ${formatDuration(total)}`;

  const pickBroll = async () => {
    try {
      const files = getMockApi() && Platform.OS === 'web' ? sampleFiles('media', 2) : await pickFromLibrary('media');
      setBroll((b) => [...b, ...files.filter((f) => !b.some((x) => x.uri === f.uri))].slice(0, 30));
    } catch (e) {
      notify("Couldn't open your library", errorMessage(e));
    }
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      const req = buildBatchRequest(session, settings, title || defaultTitle(session), broll);
      const res = await getApi().createBatch(req);
      await getUploadQueue().enqueue(recordingUploadJobs(res, session, broll));
      leaving.current = true;
      void qc.invalidateQueries({ queryKey: keys.home });
      haptic(motionHaptics.success);
      toast.show({ kind: 'success', text: 'Kilo is editing your video' });
      router.dismissAll();
      router.push(`/batch/${res.batch.id}`);
      // The takes stay on disk until the upload queue has them on the server; it deletes them then.
      endSession({ deleteTakes: false });
    } catch (e) {
      haptic(motionHaptics.toastError);
      notify("Couldn't start the edit", errorMessage(e));
      setSubmitting(false);
    }
  };

  return (
    <Screen
      appearance="auto"
      gap={12}
      header={{ title: 'Ready to edit', meta, onBack: back }}
      footer={
        <>
          <PillButton label="Edit this video" onPress={submit} loading={submitting} disabled={kept === 0} testID="submit-recording" />
          <PillButton variant="text" label="Back to recording" onPress={back} testID="back-to-recording" />
        </>
      }
    >
      <View style={{ gap: 6 }}>
        <Text variant="secondary" tone="muted">
          Video name
        </Text>
        <TextInput
          value={title}
          onChangeText={(t) => updateRecorder((st) => setTitle(st, t))}
          placeholder={defaultTitle(session)}
          placeholderTextColor={c.muted}
          maxLength={120}
          accessibilityLabel="Video name"
          style={s.input}
          testID="video-title"
        />
      </View>

      <Animated.View entering={m.appearAt(0)}>
        <Card padding={0} paddingHorizontal={16} testID="takes-summary">
          <View style={[s.take, { minHeight: 56 }]} accessible accessibilityLabel={`${plural(kept, 'clip')}, ${formatDuration(total)} in all`}>
            <View style={s.summary}>
              <Text variant="title" tabular>
                {plural(kept, 'clip')}
              </Text>
              <Text variant="secondary" tone="muted" tabular>
                {formatDuration(total)}
              </Text>
            </View>
          </View>
          {session.lines.map((l, i) =>
            l.kept ? (
              <View key={l.key} style={[s.take, s.divider]}>
                <SymbolIcon name="check" size={16} color={c.accent} strokeWidth={2.4} />
                <Text variant="body" style={{ flex: 1 }} numberOfLines={2}>
                  {free ? `Clip ${i + 1}` : l.text}
                </Text>
                <Text variant="label" tone="muted" tabular>
                  Take {l.kept.takeNumber} · {formatDuration(l.kept.durationSec)}
                </Text>
              </View>
            ) : free ? null : (
              <View key={l.key} style={[s.take, s.divider]}>
                <SymbolIcon name="alert" size={16} color={c.cut} />
                <Text variant="body" tone="muted" strike style={{ flex: 1 }} numberOfLines={2}>
                  {l.text}
                </Text>
                <Text variant="label" tone="cut">
                  Not recorded
                </Text>
              </View>
            ),
          )}
        </Card>
      </Animated.View>
      {missing.length ? (
        <Text variant="label" tone="muted">
          {plural(missing.length, 'line')} not recorded. Kilo edits the video without {missing.length === 1 ? 'it' : 'them'}.
        </Text>
      ) : null}

      <Animated.View entering={m.appearAt(1)} style={s.drop}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="body" weight={500}>
            B-roll for this video
          </Text>
          <Text variant="label" tone="muted" numberOfLines={2}>
            {broll.length ? `${plural(broll.length, 'shot')} added: ${broll.map((b) => b.filename).join(', ')}` : 'Drop in product shots. Kilo places them.'}
          </Text>
        </View>
        <PillButton variant="secondary" surface="content" label={broll.length ? 'Add more' : 'Add clips'} height={44} onPress={pickBroll} accessibilityLabel="Add B-roll clips" style={{ flexShrink: 0 }} testID="finish-broll" />
      </Animated.View>

      <Animated.View entering={m.appearAt(2)} style={{ gap: 12 }}>
        <StyleChooser settings={settings} onPick={change} />
        <ModeControl settings={settings} onChange={change} />
        <EditSwitches settings={settings} set={set} />
        <HookVariations settings={settings} set={set} perVideo="This video ships with" />
      </Animated.View>
    </Screen>
  );
}
