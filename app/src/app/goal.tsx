import { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { GoalView } from '@kilo/edl';
import { getApi } from '@/api/client';
import { errorMessage } from '@/api/errors';
import { keys, useGoal } from '@/api/queries';
import { deviceTimeZone, formatHour, goalFormFrom, goalHeadline, isDirty, streakLine, toUpdateRequest, withHour, withPerWeek, type GoalForm } from '@/goal/goalForm';
import { getNotificationPermission, openNotificationSettings, requestNotificationPermission, type NotificationPermission } from '@/push/permission';
import { getPushToken } from '@/push/PushManager';
import { Card, ErrorState, Header, Icon, LoadingBlock, PillButton, Row, Screen, StepBar, Stepper, Text, Toggle, color } from '@/ui';

/** Weekly goal and reminder (GET/PUT /v1/goal). */
export default function GoalScreen() {
  const goal = useGoal();
  if (goal.isPending) {
    return (
      <Screen>
        <Header title="Weekly goal" />
        <LoadingBlock />
      </Screen>
    );
  }
  if (!goal.data) {
    return (
      <Screen>
        <Header title="Weekly goal" />
        <ErrorState error={goal.error} onRetry={() => void goal.refetch()} />
      </Screen>
    );
  }
  return <GoalBody view={goal.data} />;
}

function GoalBody({ view }: { view: GoalView }) {
  const qc = useQueryClient();
  const tz = useMemo(deviceTimeZone, []);
  const [form, setForm] = useState<GoalForm>(() => goalFormFrom(view));
  const [perm, setPerm] = useState<NotificationPermission | null>(null);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    void getNotificationPermission().then(setPerm).catch(() => setPerm('unavailable'));
  }, []);

  const save = useMutation({
    mutationFn: (f: GoalForm) => getApi().updateGoal(toUpdateRequest(f, tz)),
    onSuccess: (g) => {
      qc.setQueryData(keys.goal, g);
      void qc.invalidateQueries({ queryKey: keys.home });
      setForm(goalFormFrom(g));
    },
  });
  const dirty = isDirty(form, view, tz);

  /** The permission prompt comes at the moment a reminder is turned on. */
  const setReminder = async (on: boolean) => {
    if (!on) return setForm({ ...form, reminderEnabled: false });
    setAsking(true);
    try {
      const p = await requestNotificationPermission();
      setPerm(p);
      if (p === 'granted') {
        setForm({ ...form, reminderEnabled: true });
        // Make sure this device can receive the reminder.
        if (Platform.OS !== 'web') {
          const token = await getPushToken().catch(() => null);
          if (token) await getApi().registerDevice({ expoPushToken: token, platform: Platform.OS === 'ios' ? 'ios' : 'android' }).catch(() => undefined);
        }
      }
    } finally {
      setAsking(false);
    }
  };

  const off = form.videosPerWeek === 0;
  const blocked = perm === 'denied' || perm === 'unavailable';

  return (
    <Screen
      gap={12}
      footer={
        <>
          {save.isError ? (
            <Text variant="secondary" tone="cut" center>
              {errorMessage(save.error)}
            </Text>
          ) : null}
          <PillButton label={dirty ? 'Save' : save.isSuccess ? 'Saved' : 'Save'} onPress={() => save.mutate(form)} disabled={!dirty} loading={save.isPending} testID="save-goal" />
        </>
      }
    >
      <Header title="Weekly goal" />

      <Card gap={12} testID="goal-progress">
        <View style={styles.spread}>
          <Text variant="secondary" tone="muted">
            This week
          </Text>
          <Text variant="secondary" tone="muted">
            {streakLine(view.streakWeeks)}
          </Text>
        </View>
        <Text variant="goal">{goalHeadline(view)}</Text>
        {view.videosPerWeek > 0 ? <StepBar done={view.postedThisWeek} total={view.videosPerWeek} accessibilityLabel={goalHeadline(view)} /> : null}
        <Text variant="label" tone="muted">
          A video counts once it is posted. The week starts Monday.
        </Text>
      </Card>

      <Card padding={0} paddingHorizontal={16}>
        <Row
          minHeight={64}
          title="Videos per week"
          subtitle={off ? 'Goal off' : '0 turns the goal off'}
          right={<Stepper value={form.videosPerWeek} min={0} max={50} onChange={(n) => setForm(withPerWeek(form, n))} noun="videos per week" />}
        />
      </Card>

      <Card padding={0} paddingHorizontal={16} style={off ? { opacity: 0.5 } : undefined}>
        <Row
          title="Remind me"
          subtitle={off ? 'Set a goal first' : 'A nudge when you are behind on your goal'}
          right={<Toggle value={form.reminderEnabled} onValueChange={(v) => void setReminder(v)} disabled={off || asking} accessibilityLabel="Remind me" testID="reminder-toggle" />}
        />
        {form.reminderEnabled && !off ? (
          <Row
            divider
            minHeight={60}
            title={`At ${formatHour(form.hour)}`}
            subtitle={`Your time, ${tz.replace(/_/g, ' ')}`}
            right={<HourStepper hour={form.hour} onChange={(h) => setForm(withHour(form, h))} />}
            testID="reminder-hour"
          />
        ) : null}
      </Card>

      {blocked && !off ? (
        <Card gap={10} testID="notifications-off">
          <View style={styles.spread}>
            <Icon name="bell" size={22} color={color.cut} />
            <Text variant="body" weight={600} style={{ flex: 1 }}>
              Notifications are off for Kilo
            </Text>
          </View>
          <Text variant="secondary" tone="muted">
            {perm === 'unavailable'
              ? 'This device cannot show notifications. Your goal still counts your videos.'
              : Platform.OS === 'web'
                ? 'Allow notifications for this site in your browser settings, then turn the reminder on.'
                : 'Turn them on in Settings, then come back and turn the reminder on.'}
          </Text>
          {Platform.OS !== 'web' && perm === 'denied' ? <PillButton variant="secondary" height={44} label="Open Settings" onPress={openNotificationSettings} /> : null}
        </Card>
      ) : null}
    </Screen>
  );
}

/** − 6 pm + : steps an hour, wrapping around midnight. */
function HourStepper({ hour, onChange }: { hour: number; onChange: (h: number) => void }) {
  const btn = (glyph: string, label: string, d: number) => (
    <Pressable onPress={() => onChange(hour + d)} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [styles.stepButton, pressed && { opacity: 0.7 }]} testID={d < 0 ? 'hour-earlier' : 'hour-later'}>
      <Text variant="body" style={{ fontSize: 20, lineHeight: 22 }}>
        {glyph}
      </Text>
    </Pressable>
  );
  return (
    <View style={styles.stepper} accessibilityRole="adjustable" accessibilityLabel="Reminder time" accessibilityValue={{ text: formatHour(hour) }}>
      {btn('−', 'An hour earlier', -1)}
      {btn('+', 'An hour later', 1)}
    </View>
  );
}

const styles = StyleSheet.create({
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepButton: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, borderColor: color.outline, backgroundColor: color.white, alignItems: 'center', justifyContent: 'center' },
  spread: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
});
