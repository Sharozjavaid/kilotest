import { router } from 'expo-router';
import { Card, PillButton, Row, Text } from '@/ui';
import { Placeholder } from '@/components/Placeholder';
import { useAuth } from '@/auth/AuthProvider';

/** Placeholder: account, weekly goal and reminders. Built by the next mobile engineer. Sign-out works today. */
export default function YouScreen() {
  const auth = useAuth();
  const who = auth.session?.email ?? (auth.mode === 'dev' ? `Dev user ${auth.session?.userId.slice(0, 8) ?? ''}` : 'Signed in');
  return (
    <Placeholder tab title="You" icon="user" body="Your account, weekly goal and reminders will live here.">
      <Card padding={0} paddingHorizontal={16}>
        <Row title={who} subtitle={auth.mode === 'supabase' ? 'Signed in with email' : auth.mode === 'dev' ? 'Local server dev sign-in' : 'Mock mode'} />
        <Row divider title="Weekly goal" onPress={() => router.push('/goal')} chevron />
      </Card>
      <PillButton variant="text" destructive label="Sign out" onPress={() => void auth.signOut()} />
      <Text variant="label" tone="muted" center>
        kilo · AI video editor
      </Text>
    </Placeholder>
  );
}
