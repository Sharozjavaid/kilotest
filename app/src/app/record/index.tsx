import { useEffect, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { addLine, deleteLine, hasProgress, keptCount, moveLine, setLineText, startRecording } from '@/recorder/session';
import { endSession, loadRecorder, startSession, updateRecorder, useRecorder } from '@/recorder/store';
import { plural } from '@/lib/format';
import { AutoGrowInput } from '@/components/AutoGrowInput';
import { Card, Header, Icon, IconButton, LoadingBlock, PillButton, Screen, Text, color, radius, typeStyle } from '@/ui';

/** Record with script, step 1: paste or type the script, then edit the lines. */
export default function RecordScriptScreen() {
  const { loaded, session, lost } = useRecorder();
  const [paste, setPaste] = useState('');
  useEffect(() => {
    void loadRecorder();
  }, []);

  if (!loaded) {
    return (
      <Screen>
        <Header title="Record with script" />
        <LoadingBlock />
      </Screen>
    );
  }

  const inProgress = !!session && session.stage !== 'script' && hasProgress(session);
  const scriptLines = session?.mode === 'script' ? session.lines : [];
  const editing = scriptLines.length > 0;
  const usable = scriptLines.filter((l) => l.text.trim()).length;

  const record = () => {
    if (!session || session.mode !== 'script') return;
    updateRecorder((s) => startRecording(s));
    router.push('/record/camera');
  };
  const freeRecord = () => {
    startSession('free');
    router.push('/record/camera');
  };
  const useScript = () => {
    if (!paste.trim()) return;
    startSession('script', paste);
    setPaste('');
  };

  return (
    <Screen
      gap={12}
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
      <Header title="Record with script" meta={editing ? plural(scriptLines.length, 'line') : undefined} />

      {inProgress && session ? (
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
            <PillButton variant="secondary" label="Start over" height={44} style={{ flex: 1 }} onPress={() => endSession({ deleteTakes: true })} testID="start-over" />
          </View>
        </Card>
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
            placeholderTextColor={color.muted}
            accessibilityLabel="Your script"
            style={styles.paste}
            textAlignVertical="top"
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
              <View key={l.key} style={[styles.line, i > 0 && styles.divider]} testID={`line-${i}`}>
                <View style={styles.num}>
                  {l.kept ? <Icon name="check" size={16} color={color.accent} strokeWidth={2.4} /> : <Text variant="secondary" tone="muted">{i + 1}</Text>}
                </View>
                <AutoGrowInput
                  value={l.text}
                  onChangeText={(t) => updateRecorder((s) => setLineText(s, i, t))}
                  placeholder="New line"
                  placeholderTextColor={color.muted}
                  accessibilityLabel={`Line ${i + 1}${l.kept ? ', recorded' : ''}`}
                  style={styles.lineInput}
                  testID={`line-input-${i}`}
                />
                <IconButton glass={false} icon="chevronUp" label={`Move line ${i + 1} up`} disabled={i === 0} onPress={() => updateRecorder((s) => moveLine(s, i, i - 1))} />
                <IconButton glass={false} icon="chevronDown" label={`Move line ${i + 1} down`} disabled={i === scriptLines.length - 1} onPress={() => updateRecorder((s) => moveLine(s, i, i + 1))} />
                <IconButton glass={false} icon="close" label={`Delete line ${i + 1}`} onPress={() => updateRecorder((s) => deleteLine(s, i))} />
              </View>
            ))}
          </Card>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <PillButton variant="text" icon="plus" label="Add a line" onPress={() => updateRecorder((s) => addLine(s, s.lines.length - 1))} testID="add-line" />
            <PillButton variant="text" label="New script" onPress={() => endSession({ deleteTakes: true })} />
          </View>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  paste: {
    ...typeStyle('body'),
    color: color.ink,
    minHeight: 260,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: color.hairline,
    backgroundColor: color.surfaceStrong,
    padding: 16,
    lineHeight: 22,
  },
  line: { flexDirection: 'row', alignItems: 'center', minHeight: 56, gap: 2 },
  divider: { borderTopWidth: 1, borderTopColor: color.hairline },
  num: { width: 24, alignItems: 'center' },
  lineInput: { ...typeStyle('transcript'), color: color.ink, flex: 1, paddingVertical: 10, paddingHorizontal: 6 },
});
