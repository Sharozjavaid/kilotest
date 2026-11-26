import Constants from 'expo-constants';
import { router } from 'expo-router';
import { View } from 'react-native';
import { useAuth } from '@/auth/AuthProvider';
import { useGoal } from '@/api/queries';
import { goalSummary } from '@/goal/goalForm';
import { useStyles } from '@/styles/useStyles';
import { plural } from '@/lib/format';
import { Card, Header, Icon, PillButton, Row, Screen, Text, color } from '@/ui';

/** You: account, weekly goal, styles, app version and sign out. */
export default function YouScreen() {
  const auth = useAuth();
  const goal = useGoal();
  const styles = useStyles();
  const email = auth.session?.email;
  const who = email ?? 'dev account';
  const how = auth.mode === 'supabase' ? 'Signed in with email' : auth.mode === 'dev' ? `Local server · ${auth.session?.userId.slice(0, 8) ?? ''}` : 'Mock mode, nothing leaves this device';
  const version = Constants.expoConfig?.version ?? '1.0.0';

  return (
    <Screen bottomInset={false} gap={12} testID="you">
      <Header title="You" noBack />
      <Card padding={0} paddingHorizontal={16}>
        <Row
          left={
            <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: color.skyTint, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="user" size={20} color={color.accent} />
            </View>
          }
          title={who}
          subtitle={how}
          minHeight={64}
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
