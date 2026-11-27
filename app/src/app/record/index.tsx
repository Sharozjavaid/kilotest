import { useEffect, useRef, useState } from 'react';
import { TextInput, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { router } from 'expo-router';
import { addLine, deleteLine, hasProgress, keptCount, moveLine, setLineText, startRecording } from '@/recorder/session';
import { endSession, loadRecorder, startSession, updateRecorder, useRecorder } from '@/recorder/store';
import { plural } from '@/lib/format';
import { AutoGrowInput } from '@/components/AutoGrowInput';
import { Card, IconButton, PillButton, Screen, Skeleton, SymbolIcon, Text, haptic, makeStyles, radius, typeStyle, useColors, useLayoutMotion, useTheme } from '@/ui';

const useStyles = makeStyles((t) => ({
  paste: {
    ...typeStyle('body'),
    color: t.color.ink,
    minHeight: 160,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: t.color.hairline,
    backgroundColor: t.scheme === 'dark' ? t.color.fill : 'rgba(255,255,255,0.9)',
    padding: 16,
    lineHeight: 22,
  },
  line: { flexDirection: 'row', alignItems: 'center', minHeight: 56, gap: 2 },
  divider: { borderTopWidth: 1, borderTopColor: t.color.hairline },
  num: { width: 24, alignItems: 'center' },
  lineInput: { ...typeStyle('body'), color: t.color.ink, flex: 1, paddingVertical: 10, paddingHorizontal: 6 },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
}));

/** Rows that mount within this long after "Split into lines" arrive in a stagger; later ones with `listInsert`. */
const SPLIT_STAGGER_WINDOW_MS = 400;

/** Record with script, step 1 (design brief 4.13): paste or type the script, then edit the lines. */
export default function RecordScriptScreen() {
  const s = useStyles();
  const c = useColors();
  const t = useTheme();
  const m = useLayoutMotion();
  const { loaded, session, lost } = useRecorder();
  const [paste, setPaste] = useState('');
  const splitAt = useRef(0);
  useEffect(() => {
    void loadRecorder();
  }, []);

  const scriptLines = session?.mode === 'script' ? session.lines : [];
  const editing = scriptLines.length > 0;

  if (!loaded) {
    return (
      <Screen appearance="auto" header={{ title: 'Record with script' }}>
        <View style={{ gap: 12 }} accessibilityLabel="Loading" accessibilityRole="progressbar">
          <Skeleton height={160} radius={16} />
          <Skeleton height={56} radius={20} />
        </View>
      </Screen>
    );
  }

  const inProgress = !!session && session.stage !== 'script' && hasProgress(session);
  const usable = scriptLines.filter((l) => l.text.trim()).length;
  const staggering = Date.now() - splitAt.current < SPLIT_STAGGER_WINDOW_MS;

  const record = () => {
    if (!session || session.mode !== 'script') return;
    updateRecorder((st) => startRecording(st));
    router.push('/record/camera');
  };
  const freeRecord = () => {
    startSession('free');
    router.push('/record/camera');
  };
  const useScript = () => {
    if (!paste.trim()) return;
    splitAt.current = Date.now();
    startSession('script', paste);
    setPaste('');
  };
  const move = (from: number, to: number) => {
    haptic('light');
    updateRecorder((st) => moveLine(st, from, to));
  };

  return (
    <Screen
      appearance="auto"
      gap={12}
      header={{ title: 'Record with script', meta: editing ? plural(scriptLines.length, 'line') : undefined }}
      footer={
        <>
          {editing ? (
            <PillButton label={`Record ${plural(usable, 'line')}`} icon="camera" onPress={record} disabled={!usable} testID="start-recording" />
          ) : (
            <PillButton label="Split into lines" onPress={useScript} disabled={!paste.trim()} testID="split-script" />
          )}
          <PillButton variant="text" label="No script, just record" onPress={freeRecord} testID="free-record" />
        </>
      }
    >
      {inProgress && session ? (
        <Animated.View entering={m.appear}>
          <Card gap={10} testID="resume-card">
            <Text variant="body" weight={600}>
              {session.mode === 'free' ? 'Recording in progress' : 'Your recording is saved'}
            </Text>
            <Text variant="secondary" tone="muted">
              {session.mode === 'free' ? `${plural(keptCount(session), 'clip')} kept.` : `${keptCount(session)} of ${plural(session.lines.length, 'line')} kept.`}
              {lost ? ` ${plural(lost, 'take')} could not be found and need recording again.` : ''}
            </Text>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <PillButton label="Continue" height={44} style={{ flex: 1 }} onPress={() => router.push(session.stage === 'finish' ? '/record/finish' : '/record/camera')} testID="resume" />
              <PillButton variant="secondary" surface="content" label="Start over" height={44} style={{ flex: 1 }} onPress={() => endSession({ deleteTakes: true })} testID="start-over" />
            </View>
          </Card>
        </Animated.View>
      ) : null}

      {!editing ? (
        <>
          <Text variant="secondary" tone="muted">
            Paste or type what you want to say. Kilo splits it into lines and shows them one at a time while you record, one clip per line.
          </Text>
          <TextInput
            value={paste}
            onChangeText={setPaste}
            multiline
            placeholder={"Okay, I've used this every morning for two weeks.\nHere's what nobody tells you about it."}
            placeholderTextColor={c.muted}
            accessibilityLabel="Your script"
            style={s.paste}
            textAlignVertical="top"
            keyboardAppearance={t.scheme}
            testID="script-input"
          />
        </>
      ) : (
        <>
          <Text variant="secondary" tone="muted">
            One clip per line. Edit, add, remove or reorder lines before you record.
          </Text>
          <Card padding={0} paddingHorizontal={12}>
            {scriptLines.map((l, i) => (
              <Animated.View
                key={l.key}
                entering={staggering ? m.appearAt(i) : m.listInsert}
                exiting={m.listRemove}
                layout={m.listLayout}
                style={[s.line, i > 0 && s.divider]}
                testID={`line-${i}`}
              >
                <View style={s.num}>
                  {l.kept ? (
                    <SymbolIcon name="check" size={16} color={c.accent} strokeWidth={2.4} />
                  ) : (
                    <Text variant="secondary" tone="muted" tabular>
                      {i + 1}
                    </Text>
                  )}
                </View>
                <AutoGrowInput
                  value={l.text}
                  onChangeText={(t) => updateRecorder((st) => setLineText(st, i, t))}
                  placeholder="New line"
                  placeholderTextColor={c.muted}
                  accessibilityLabel={`Line ${i + 1}${l.kept ? ', recorded' : ''}`}
                  style={s.lineInput}
                  testID={`line-input-${i}`}
                />
                <IconButton glass={false} icon="chevronUp" label={`Move line ${i + 1} up`} disabled={i === 0} onPress={() => move(i, i - 1)} />
                <IconButton glass={false} icon="chevronDown" label={`Move line ${i + 1} down`} disabled={i === scriptLines.length - 1} onPress={() => move(i, i + 1)} />
                <IconButton glass={false} icon="close" label={`Delete line ${i + 1}`} onPress={() => updateRecorder((st) => deleteLine(st, i))} />
              </Animated.View>
            ))}
          </Card>
          <View style={s.row}>
            <PillButton variant="text" icon="plus" label="Add a line" onPress={() => updateRecorder((st) => addLine(st, st.lines.length - 1))} testID="add-line" />
            <PillButton variant="text" label="New script" onPress={() => endSession({ deleteTakes: true })} />
          </View>
        </>
      )}
    </Screen>
  );
}
