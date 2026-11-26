import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '@/auth/AuthProvider';
import { Card, Icon, PillButton, Screen, Text, Wordmark, color, radius, typeStyle } from '@/ui';

/** Signed-out welcome with email one-time-code sign-in. */
export default function WelcomeScreen() {
  const auth = useAuth();
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await auth.sendCode(email.trim());
      setStep('code');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      await auth.verifyCode(email.trim(), code.trim());
      router.replace('/');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen
        gap={24}
        footer={
          step === 'email' ? (
            <PillButton label="Send me a code" onPress={send} disabled={!validEmail} loading={busy} />
          ) : (
            <>
              <PillButton label="Sign in" onPress={verify} disabled={code.trim().length < 6} loading={busy} />
              <PillButton variant="text" label="Use a different email" onPress={() => { setStep('email'); setCode(''); setError(null); }} />
            </>
          )
        }
      >
        <View style={styles.hero}>
          <Wordmark size={56} />
          <Text variant="titleSm" weight={500} tone="muted">
            AI video editor
          </Text>
        </View>

        <Card gap={14}>
          <Point icon="videos" text="Drop in raw talking clips." />
          <Point icon="sparkle" text="Kilo cuts dead air, retakes and filler." />
          <Point icon="check" text="Check it in a minute, then post a tight 9:16 video." />
        </Card>

        {step === 'email' ? (
          <View style={styles.field}>
            <Text variant="secondary" tone="muted" nativeID="emailLabel">
              Email
            </Text>
            <TextInput
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              placeholderTextColor={color.muted}
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              textContentType="emailAddress"
              returnKeyType="send"
              onSubmitEditing={() => validEmail && void send()}
              accessibilityLabel="Email"
              accessibilityLabelledBy="emailLabel"
              style={styles.input}
            />
            <Text variant="label" tone="muted">
              We'll email you a 6-digit code. No password.
            </Text>
          </View>
        ) : (
          <View style={styles.field}>
            <Text variant="secondary" tone="muted">
              Code sent to {email.trim()}
            </Text>
            <TextInput
              value={code}
              onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
              placeholder="123456"
              placeholderTextColor={color.muted}
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              autoComplete="one-time-code"
              autoFocus
              maxLength={6}
              accessibilityLabel="6-digit code"
              style={[styles.input, styles.code]}
            />
          </View>
        )}
        {error ? (
          <Text variant="secondary" tone="cut" accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
        {auth.mode === 'mock' ? (
          <Text variant="label" tone="muted">
            Mock mode: you are already signed in. Any 6-digit code works here.
          </Text>
        ) : null}
      </Screen>
    </KeyboardAvoidingView>
  );
}

function Point({ icon, text }: { icon: 'videos' | 'sparkle' | 'check'; text: string }) {
  return (
    <View style={styles.point}>
      <View style={styles.pointIcon}>
        <Icon name={icon} size={18} color={color.accent} />
      </View>
      <Text variant="body" style={{ flex: 1 }}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { paddingTop: 48, gap: 4 },
  field: { gap: 8 },
  input: {
    ...typeStyle('body'),
    color: color.ink,
    height: 52,
    borderRadius: 26,
    paddingHorizontal: 20,
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: color.outline,
  },
  code: { letterSpacing: 6, fontSize: 20 },
  point: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  pointIcon: { width: 32, height: 32, borderRadius: radius.md, backgroundColor: color.skyTint, alignItems: 'center', justifyContent: 'center' },
});
