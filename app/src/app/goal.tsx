import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Platform, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { router } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { GoalView } from '@kilo/edl';
import { getApi } from '@/api/client';
import { errorMessage } from '@/api/errors';
import { keys, useGoal } from '@/api/queries';
import { deviceTimeZone, formatHour, goalFormFrom, goalHeadline, isDirty, streakLine, toUpdateRequest, withHour, withPerWeek, type GoalForm } from '@/goal/goalForm';
import { getNotificationPermission, openNotificationSettings, requestNotificationPermission, type NotificationPermission } from '@/push/permission';
import { getPushToken } from '@/push/PushManager';
import { Card, ErrorState, LoadingBlock, PillButton, PressableScale, Row, Screen, StepBar, Stepper, SymbolIcon, Text, Toggle, makeStyles, useColors, useLayoutMotion, type ScreenProps } from '@/ui';
import { SheetHeader } from '@/components/SheetHeader';
import { FOOTER_BUTTON } from '@/components/sizes';

const ios = Platform.OS === 'ios';

const close = () => (router.canGoBack() ? router.back() : router.replace('/'));

/**
 * The goal's frame. iOS: a form sheet (medium and large detents) on the system glass, with its own
 * title row and a glass close button (brief 4.12, 5.9). Elsewhere a pushed screen with the usual header.
 */
function GoalScreenFrame({ children, ...props }: Omit<ScreenProps, 'appearance' | 'header' | 'sheet' | 'ground'> & { children: ReactNode }) {
  return (
    <Screen appearance="auto" sheet ground="none" header={ios ? undefined : { title: 'Weekly goal' }} {...props}>
      {ios ? <SheetHeader title="Weekly goal" onClose={close} /> : null}
      {children}
    </Screen>
  );
}

/** Weekly goal and reminder (GET/PUT /v1/goal). */
export default function GoalScreen() {
  const goal = useGoal();
  if (goal.isPending) {
    return (
      <GoalScreenFrame>
        <LoadingBlock />
      </GoalScreenFrame>
    );
  }
  if (!goal.data) {
    return (
      <GoalScreenFrame>
        <ErrorState error={goal.error} onRetry={() => void goal.refetch()} />
      </GoalScreenFrame>
    );
  }
  return <GoalBody view={goal.data} />;
}

function GoalBody({ view }: { view: GoalView }) {
  const styles = useStyles();
  const c = useColors();
  const m = useLayoutMotion();
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
    <GoalScreenFrame
      gap={12}
      footerGlass
      footer={
        <>
          {save.isError ? (
            <Text variant="secondary" tone="cut" center>
              {errorMessage(save.error)}
            </Text>
          ) : null}
          <PillButton label={dirty ? 'Save' : save.isSuccess ? 'Saved' : 'Save'} onPress={() => save.mutate(form)} disabled={!dirty} loading={save.isPending} height={FOOTER_BUTTON} testID="save-goal" />
        </>
      }
    >

      <Card gap={12} testID="goal-progress">
        <View style={styles.spread}>
          <Text variant="secondary" tone="muted">
            This week
          </Text>
          <Text variant="secondary" tone="muted">
            {streakLine(view.streakWeeks)}
          </Text>
        </View>
        <Text variant="goal" tabular>
          {goalHeadline(view)}
        </Text>
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
          <Animated.View entering={m.listInsert} exiting={m.listRemove}>
            <Row
              divider
              minHeight={60}
              title={`At ${formatHour(form.hour)}`}
              subtitle={`Your time, ${tz.replace(/_/g, ' ')}`}
              right={<HourStepper hour={form.hour} onChange={(h) => setForm(withHour(form, h))} />}
              testID="reminder-hour"
            />
          </Animated.View>
        ) : null}
      </Card>

      {blocked && !off ? (
        <Card gap={10} testID="notifications-off">
          <View style={styles.spread}>
            <SymbolIcon name="bell" size={20} color={c.cut} />
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
          {Platform.OS !== 'web' && perm === 'denied' ? <PillButton variant="secondary" surface="content" height={44} label="Open Settings" onPress={openNotificationSettings} /> : null}
        </Card>
      ) : null}
    </GoalScreenFrame>
  );
}

/** − 6 pm + : steps an hour, wrapping around midnight; the `selection` haptic per step. */
function HourStepper({ hour, onChange }: { hour: number; onChange: (h: number) => void }) {
  const styles = useStyles();
  const btn = (glyph: string, label: string, d: number) => (
    <PressableScale onPress={() => onChange(hour + d)} motion="icon" haptic="selection" accessibilityRole="button" accessibilityLabel={label} style={styles.stepButton} testID={d < 0 ? 'hour-earlier' : 'hour-later'}>
      <Text variant="body" style={{ fontSize: 20, lineHeight: 22 }}>
        {glyph}
      </Text>
    </PressableScale>
  );
  return (
    <View style={styles.stepper} accessibilityRole="adjustable" accessibilityLabel="Reminder time" accessibilityValue={{ text: formatHour(hour) }}>
      {btn('−', 'An hour earlier', -1)}
      {btn('+', 'An hour later', 1)}
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepButton: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, borderColor: t.color.outline, backgroundColor: t.color.fill, alignItems: 'center', justifyContent: 'center' },
  spread: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
}));
