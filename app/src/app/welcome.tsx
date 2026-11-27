import { useState } from 'react';
import { KeyboardAvoidingView, Platform, TextInput, View, useWindowDimensions } from 'react-native';
import Animated, { Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withDelay, withSequence, withSpring, withTiming, type EntryExitAnimationFunction } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/auth/AuthProvider';
import { Glass, PillButton, Screen, Text, Wordmark, distances, haptic, makeStyles, motionHaptics, springs, typeStyle, useColors, useLayoutMotion, useReducedMotionSetting, useShake } from '@/ui';

const native = Platform.OS !== 'web';
const standard = Easing.bezier(0.2, 0.8, 0.2, 1);

/** The wordmark settles: rises 12pt and fades in over 320 ms (brief 4.1). */
const brandIn: EntryExitAnimationFunction = () => {
  'worklet';
  const t = { duration: 320, easing: standard, reduceMotion: ReduceMotion.System };
  return { initialValues: { opacity: 0, transform: [{ translateY: 12 }] }, animations: { opacity: withTiming(1, t), transform: [{ translateY: withTiming(0, t) }] } };
};
/** Then the panel rises 40pt on the `sheetIn` spring, 120 ms later. */
const panelIn: EntryExitAnimationFunction = () => {
  'worklet';
  const cfg = { ...springs.sheetIn, reduceMotion: ReduceMotion.System };
  return {
    initialValues: { opacity: 0, transform: [{ translateY: distances.sheetInY }] },
    animations: { opacity: withDelay(120, withSpring(1, cfg)), transform: [{ translateY: withDelay(120, withSpring(0, cfg)) }] },
  };
};
const fadeIn = (ms: number): EntryExitAnimationFunction => () => {
  'worklet';
  return { initialValues: { opacity: 0 }, animations: { opacity: withTiming(1, { duration: ms, easing: standard, reduceMotion: ReduceMotion.Never }) } };
};
const reducedIn = fadeIn(150);

/**
 * Signed-out welcome with email one-time-code sign-in (design brief 4.1): the sky gradient, the
 * wordmark at 38% of the height, and a glass panel docked at the bottom with the field and the
 * primary action. A wrong code shakes the field with the error haptic.
 */
export default function WelcomeScreen() {
  const s = useStyles();
  const c = useColors();
  const m = useLayoutMotion();
  const reduced = useReducedMotionSetting();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const auth = useAuth();
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shake = useShake();
  const flash = useSharedValue(0);
  const flashStyle = useAnimatedStyle(() => ({ borderColor: flash.value > 0 ? c.cut : 'transparent', borderWidth: 1.5 }), [c]);
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  /** A refused input: shake (or, under Reduce Motion, flash the outline in `cut`), with the error haptic. */
  const refuse = (message: string) => {
    setError(message);
    haptic(motionHaptics.shake);
    if (!shake.shake()) flash.value = withSequence(withTiming(1, { duration: 0 }), withDelay(600, withTiming(0, { duration: 0 })));
  };

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await auth.sendCode(email.trim());
      setStep('code');
    } catch (e) {
      refuse((e as Error).message);
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
      refuse((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const fieldIn = reduced ? reducedIn : m.appear;
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen appearance="auto" scroll={false} contentStyle={s.fill}>
        <Animated.View entering={native ? (reduced ? reducedIn : brandIn) : undefined} style={[s.hero, { top: height * 0.38 - 48 }]}>
          <Wordmark size={44} />
          <Text variant="body" tone="muted">
            AI video editor
          </Text>
        </Animated.View>

        <Animated.View entering={native ? (reduced ? reducedIn : panelIn) : undefined} style={[s.panelSlot, { bottom: Math.max(insets.bottom, 12) }]}>
          <Glass kind="panel" radius={32} style={s.panel}>
            {step === 'email' ? (
              <Animated.View key="email" entering={fieldIn} style={s.field}>
                <Text variant="secondary" tone="muted" nativeID="emailLabel">
                  Email
                </Text>
                <Animated.View style={[s.inputBox, shake.style, flashStyle]}>
                  <TextInput
                    value={email}
                    onChangeText={setEmail}
                    placeholder="you@example.com"
                    placeholderTextColor={c.muted}
                    autoCapitalize="none"
                    autoComplete="email"
                    keyboardType="email-address"
                    textContentType="emailAddress"
                    returnKeyType="send"
                    onSubmitEditing={() => validEmail && void send()}
                    accessibilityLabel="Email"
                    accessibilityLabelledBy="emailLabel"
                    style={s.input}
                  />
                </Animated.View>
                <Text variant="label" tone="muted">
                  We'll email you a 6-digit code. No password.
                </Text>
              </Animated.View>
            ) : (
              <Animated.View key="code" entering={fieldIn} style={s.field}>
                <Text variant="secondary" tone="muted" numberOfLines={1}>
                  Code sent to {email.trim()}
                </Text>
                <Animated.View style={[s.inputBox, shake.style, flashStyle]}>
                  <TextInput
                    value={code}
                    onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
                    placeholder="123456"
                    placeholderTextColor={c.muted}
                    keyboardType="number-pad"
                    textContentType="oneTimeCode"
                    autoComplete="one-time-code"
                    autoFocus
                    maxLength={6}
                    accessibilityLabel="6-digit code"
                    style={[s.input, s.code]}
                  />
                </Animated.View>
              </Animated.View>
            )}
            {error ? (
              <Text variant="secondary" tone="cut" accessibilityRole="alert" numberOfLines={2}>
                {error}
              </Text>
            ) : null}
            {step === 'email' ? (
              <PillButton label="Send me a code" onPress={send} disabled={!validEmail} loading={busy} />
            ) : (
              <>
                <PillButton label="Sign in" onPress={verify} disabled={code.trim().length < 6} loading={busy} />
                <PillButton
                  variant="text"
                  label="Use a different email"
                  onPress={() => {
                    setStep('email');
                    setCode('');
                    setError(null);
                  }}
                />
              </>
            )}
            {auth.mode === 'mock' ? (
              <Text variant="label" tone="muted" center>
                Mock mode: you are already signed in. Any 6-digit code works here.
              </Text>
            ) : null}
          </Glass>
        </Animated.View>
      </Screen>
    </KeyboardAvoidingView>
  );
}

const useStyles = makeStyles((t) => ({
  fill: { paddingTop: 0, paddingBottom: 0, paddingHorizontal: 0 },
  hero: { position: 'absolute', left: 0, right: 0, alignItems: 'center', gap: 4 },
  panelSlot: { position: 'absolute', left: 12, right: 12 },
  panel: { gap: 14, paddingVertical: 20, paddingHorizontal: 20 },
  field: { gap: 8 },
  // The field is content inside the glass: white 0.9, radius 14, 52 high (brief 4.1).
  inputBox: { borderRadius: 14, backgroundColor: t.scheme === 'dark' ? t.color.fill : 'rgba(255,255,255,0.9)' },
  input: { ...typeStyle('body'), color: t.color.ink, height: 52, paddingHorizontal: 16 },
  code: { letterSpacing: 6, fontSize: 20 },
}));
