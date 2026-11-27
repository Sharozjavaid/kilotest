import Constants from 'expo-constants';
import { router } from 'expo-router';
import { View } from 'react-native';
import { useAuth } from '@/auth/AuthProvider';
import { useGoal } from '@/api/queries';
import { goalSummary } from '@/goal/goalForm';
import { useStyles as useSavedStyles } from '@/styles/useStyles';
import { plural } from '@/lib/format';
import { Card, PillButton, Row, Screen, SymbolIcon, Text, makeStyles, useColors } from '@/ui';

/**
 * You (design brief 4.11): large title, the account card, Weekly goal and Styles, sign out and
 * the version line. Grouped content cards under the native bar's scroll-edge fade on iOS.
 */
export default function YouScreen() {
  const s = useStyles();
  const c = useColors();
  const auth = useAuth();
  const goal = useGoal();
  const styles = useSavedStyles();
  const email = auth.session?.email;
  const who = email ?? 'dev account';
  const how = auth.mode === 'supabase' ? 'Signed in with email' : auth.mode === 'dev' ? `Local server · ${auth.session?.userId.slice(0, 8) ?? ''}` : 'Mock mode, nothing leaves this device';
  const version = Constants.expoConfig?.version ?? '1.0.0';

  return (
    <Screen appearance="auto" bottomInset={false} gap={16} testID="you" header={{ title: 'You', large: true, noBack: true }}>
      <Card padding={0} paddingHorizontal={16}>
        <Row
          left={
            <View style={s.avatar}>
              <SymbolIcon name="user" size={22} filled color={c.accent} />
            </View>
          }
          title={who}
          subtitle={how}
          minHeight={68}
          testID="account"
        />
      </Card>
      <Card padding={0} paddingHorizontal={16}>
        <Row title="Weekly goal" subtitle={goal.data ? goalSummary(goal.data) : 'Loading'} onPress={() => router.push('/goal')} chevron testID="you-goal" />
        <Row divider title="Styles" subtitle={styles.data ? plural(styles.data.length, 'saved style') : 'Loading'} onPress={() => router.push('/styles')} chevron />
      </Card>
      <PillButton variant="text" destructive label="Sign out" onPress={() => void auth.signOut()} testID="sign-out" />
      <Text variant="label" tone="muted" center testID="version">
        kilo {version} · AI video editor
      </Text>
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: t.color.chipOn, alignItems: 'center', justifyContent: 'center' },
}));
