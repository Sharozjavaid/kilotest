import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Platform, Pressable, StyleSheet, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useVideoPlayer, VideoView } from 'expo-video';
import Animated, { Easing, ReduceMotion, withTiming, type EntryExitAnimationFunction } from 'react-native-reanimated';
import { RecorderCamera, useRecorderPermissions } from '@/recorder/camera/RecorderCamera';
import type { CaptureInfo, RecorderCameraHandle } from '@/recorder/camera/types';
import { fpsLabel, isFullQuality, resolutionLabel } from '@/recorder/camera/capture';
import { addTake, canFinish, deleteTake, jumpTo, keepTake, keptCount, lineLabel, progressSegments, setPrefs, setStage, takeLabel, type RecorderPrefs, type RecorderSession } from '@/recorder/session';
import { loadRecorder, updateRecorder, useRecorder } from '@/recorder/store';
import { phaseHaptic, type RecorderPhase } from '@/recorder/recordButton';
import { RecordButton } from '@/recorder/RecordButton';
import { LinePills } from '@/recorder/LinePills';
import { Teleprompter } from '@/recorder/Teleprompter';
import { RecorderSheets } from '@/recorder/RecorderSheets';
import { formatDuration, plural } from '@/lib/format';
import { Glass, GlassGroup, PillButton, PressableScale, SymbolIcon, Text, ThemeScope, haptic, makeStyles, motionHaptics, prefersReducedMotion, useColors, useReducedMotionSetting, type IconName } from '@/ui';

const native = Platform.OS !== 'web';
const standard = Easing.bezier(0.2, 0.8, 0.2, 1);
const WHITE_70 = 'rgba(255,255,255,0.7)';

/** Record with script, step 2 (design brief 4.14): the camera, always dark, with glass controls over it. */
export default function RecorderScreen() {
  const { loaded, session } = useRecorder();
  useEffect(() => {
    void loadRecorder();
  }, []);
  // Only the focused screen redirects: after Finish, screens still under the stack must not navigate.
  useFocusEffect(
    useCallback(() => {
      if (loaded && !session) router.replace('/record');
    }, [loaded, session]),
  );
  return (
    <ThemeScope appearance="dark">
      <StatusBar style="light" />
      {!loaded || !session ? <View style={styles.root} /> : <Recorder session={session} />}
    </ThemeScope>
  );
}

function Recorder({ session }: { session: RecorderSession }) {
  const perms = useRecorderPermissions();
  const granted = perms.camera === 'granted' && perms.microphone === 'granted';
  if (!granted) return <PermissionGate perms={perms} />;
  return <RecorderBody session={session} />;
}

const useStyles = makeStyles((t) => ({
  top: { paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  circle: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  badge: { height: 32, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
  recDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: t.color.record },
  group: { flexDirection: 'row', gap: 8 },
  freeChip: { alignSelf: 'center', height: 32, paddingHorizontal: 14, flexDirection: 'row', gap: 8, alignItems: 'center' },
  middle: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  countdown: { fontFamily: 'Inter_700Bold', fontSize: 96, lineHeight: 104, color: '#FFFFFF', textShadowColor: 'rgba(0,0,0,0.35)', textShadowRadius: 12, textShadowOffset: { width: 0, height: 2 } },
  // Solid, not glass: the recorder keeps to six glass views.
  notice: { alignSelf: 'center', marginHorizontal: 24, marginBottom: 10, paddingVertical: 7, paddingHorizontal: 14, borderRadius: 16, backgroundColor: 'rgba(11,18,32,0.62)' },
  panel: { marginHorizontal: 12, gap: 14 },
  counters: { flexDirection: 'row', justifyContent: 'space-between' },
  controls: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', paddingHorizontal: 4 },
  side: { width: 84, alignItems: 'center', gap: 6, paddingTop: 12 },
  sideCircle: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.14)' },
  sideOn: { backgroundColor: t.color.accent },
  finish: { minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: -4 },
  preview: { width: 150, height: 267, borderRadius: 20, borderCurve: 'continuous', overflow: 'hidden', backgroundColor: t.color.player },
  previewLabel: { position: 'absolute', left: 10, right: 10, bottom: 10, height: 28, borderRadius: 14, flexDirection: 'row', gap: 6, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(11,18,32,0.55)' },
  card: { alignSelf: 'stretch', gap: 10, padding: 24, alignItems: 'center' },
}));

function RecorderBody({ session }: { session: RecorderSession }) {
  const s = useStyles();
  const insets = useSafeAreaInsets();
  const cam = useRef<RecorderCameraHandle>(null);
  const [info, setInfo] = useState<CaptureInfo | null>(null);
  const [camError, setCamError] = useState<string | null>(null);
  const [camKey, setCamKey] = useState(0);
  const [phase, setPhaseState] = useState<RecorderPhase>('idle');
  const [count, setCount] = useState(0);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [linesOpen, setLinesOpen] = useState(false);
  const [appActive, setAppActive] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const countdownToken = useRef(0);
  const phaseRef = useRef<RecorderPhase>('idle');

  // Every phase change plays its haptic once (record start medium, stop light).
  const setPhase = useCallback((next: RecorderPhase) => {
    haptic(phaseHaptic(phaseRef.current, next));
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  // Pause the camera in the background; a recording in progress is stopped and kept as a take.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => setAppActive(st === 'active'));
    return () => sub.remove();
  }, []);

  const free = session.mode === 'free';
  const line = session.lines[session.current];
  const next = session.lines[session.current + 1];
  const pending = session.pending;
  const busy = phase !== 'idle';

  const start = async () => {
    setCamError(null);
    if (session.prefs.countdown > 0) {
      const token = ++countdownToken.current;
      setPhase('countdown');
      for (let i = session.prefs.countdown; i > 0; i--) {
        setCount(i);
        haptic(motionHaptics.countdownTick);
        await new Promise((r) => setTimeout(r, 1000));
        if (countdownToken.current !== token) return;
      }
    }
    try {
      await cam.current?.start();
      setPhase('recording');
    } catch (e) {
      setCamError(e instanceof Error ? e.message : String(e));
      setPhase('idle');
    }
  };

  const stop = async () => {
    setPhase('saving');
    try {
      const file = await cam.current!.stop();
      updateRecorder((st) => addTake(st, file));
    } catch (e) {
      setCamError(e instanceof Error ? e.message : String(e));
    } finally {
      setPhase('idle');
    }
  };

  const onRecordPress = () => {
    if (phase === 'recording') return void stop();
    if (phase === 'countdown') {
      countdownToken.current += 1;
      setPhase('idle');
      return;
    }
    if (phase === 'idle') void start();
  };

  useEffect(() => {
    if (!appActive && phase === 'recording') void stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appActive]);

  const leave = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/record');
  };
  const close = async () => {
    countdownToken.current += 1;
    if (phase === 'recording') await cam.current?.cancel();
    // A take waiting for Keep or Delete is the one thing closing would lose.
    if (pending && native) {
      Alert.alert('Leave this take?', 'The take you just recorded is not kept yet. Your kept lines stay saved.', [
        { text: 'Stay', style: 'cancel' },
        { text: 'Leave', style: 'destructive', onPress: leave },
      ]);
      return;
    }
    leave();
  };

  const keep = () => {
    haptic(motionHaptics.cut); // `impact light` with the teleprompter's move to the next line
    updateRecorder((st) => keepTake(st));
  };
  // Delete take: the preview shrinks and fades (160 ms) and the warning haptic plays, then the take goes.
  const removeTake = () => {
    haptic(motionHaptics.remove);
    setDeleting(true);
  };
  useEffect(() => {
    if (!deleting) return;
    updateRecorder(deleteTake);
    setDeleting(false);
  }, [deleting]);

  const finish = () => {
    updateRecorder((st) => setStage(st, 'finish'));
    router.push('/record/finish');
  };

  const kept = keptCount(session);
  const quality = info ? isFullQuality(info) : true;
  const finishable = canFinish(session) && !busy;
  const onJump = useCallback((i: number) => updateRecorder((st) => jumpTo(st, i)), []);
  const onPrefs = useCallback((p: Partial<RecorderPrefs>) => updateRecorder((st) => setPrefs(st, p)), []);

  return (
    <View style={styles.root} testID="recorder">
      <RecorderCamera key={`${camKey}-${session.prefs.facing}`} ref={cam} facing={session.prefs.facing} active={appActive} onCaptureInfo={setInfo} onError={setCamError} style={StyleSheet.absoluteFill} />

      <View style={{ flex: 1, paddingTop: Math.max(insets.top, 12) + 8, paddingBottom: Math.max(insets.bottom, 12) }} pointerEvents="box-none">
        {/* Top row: close, capture badge, flip and Aa in one glass cluster. */}
        <View style={s.top}>
          <CamButton icon="close" label="Close camera" onPress={() => void close()} testID="close-camera" />
          <Glass kind="button" appearance="dark" radius={16} style={s.badge} accessibilityLabel={info ? `Recording at ${fpsLabel(info.fps)}, ${resolutionLabel(info)}` : 'Starting camera'} testID="capture-badge">
            {phase === 'recording' ? (
              <>
                <View style={s.recDot} />
                <Timer />
              </>
            ) : null}
            {info ? (
              <>
                <Text variant="secondary" weight={600} tone={quality ? 'accent' : 'cut'} tabular>
                  {fpsLabel(info.fps)}
                </Text>
                <Text variant="secondary" weight={600} style={{ color: WHITE_70 }}>
                  {resolutionLabel(info)}
                </Text>
              </>
            ) : (
              <Text variant="secondary" weight={600} style={{ color: WHITE_70 }}>
                Starting…
              </Text>
            )}
          </Glass>
          <GlassGroup style={s.group}>
            <CamButton
              icon="flip"
              label={`Switch to the ${session.prefs.facing === 'front' ? 'back' : 'front'} camera`}
              disabled={busy}
              onPress={() => updateRecorder((st) => setPrefs(st, { facing: st.prefs.facing === 'front' ? 'back' : 'front' }))}
              testID="flip-camera"
            />
            <CamButton glyph="Aa" label="Script size, scroll speed and countdown" onPress={() => setPrefsOpen(true)} testID="text-size" />
          </GlassGroup>
        </View>

        {/* Teleprompter, near the lens. */}
        <View style={{ marginTop: 12 }}>
          {free ? (
            <Glass kind="button" appearance="dark" radius={16} style={s.freeChip} testID="free-chip">
              <Text variant="label" weight={600} tone="accent" style={{ letterSpacing: 0.5 }}>
                {lineLabel(session)}
              </Text>
              <Text variant="label" style={{ color: WHITE_70 }}>
                No script
              </Text>
            </Glass>
          ) : line ? (
            <Teleprompter
              label={lineLabel(session)}
              lineKey={line.key}
              lineText={line.text}
              nextText={next?.text}
              textSize={session.prefs.textSize}
              scrollSpeed={session.prefs.scrollSpeed}
              recording={phase === 'recording'}
            />
          ) : null}
        </View>

        <View style={s.middle} pointerEvents="box-none">
          {phase === 'countdown' ? <Countdown key={count} n={count} /> : null}
          {camError ? (
            <ThemeScope appearance="light">
              <Glass kind="panel" appearance="light" style={s.card}>
                <Text variant="bodyLg" center>
                  The camera stopped
                </Text>
                <Text variant="secondary" tone="muted" center>
                  {camError}
                </Text>
                <PillButton
                  variant="secondary"
                  surface="content"
                  height={44}
                  label="Try again"
                  icon="refresh"
                  onPress={() => {
                    setCamError(null);
                    setCamKey((k) => k + 1);
                  }}
                />
              </Glass>
            </ThemeScope>
          ) : null}
          {pending && phase === 'idle' && !camError && !deleting ? (
            <TakePreview key={pending.id} uri={pending.uri} label={`Take ${pending.takeNumber} · ${formatDuration(pending.durationSec)}`} />
          ) : null}
        </View>

        {!quality && info && phase === 'idle' ? (
          <View style={s.notice} testID="quality-notice">
            <Text variant="label" weight={500} tone="white" center>
              This camera gives {fpsLabel(info.fps)} at {resolutionLabel(info)}. Kilo edits it as it is.
            </Text>
          </View>
        ) : null}

        {/* Control panel: line pills, counters, the controls row, Finish. */}
        <Glass kind="panel" appearance="dark" radius={32} style={s.panel}>
          <LinePills states={progressSegments(session)} keys={session.lines.map((l) => l.key)} free={free} disabled={busy} onJump={onJump} />
          <View style={s.counters}>
            <Text variant="secondary" style={{ color: WHITE_70 }} testID="kept-count">
              {plural(kept, free ? 'clip' : 'line')} kept
            </Text>
            <Text variant="secondary" style={{ color: WHITE_70 }} testID="take-label">
              {takeLabel(session)}
            </Text>
          </View>
          <View style={s.controls}>
            {pending ? (
              <SideButton icon="trash" label="Delete take" tone="cut" onPress={removeTake} disabled={busy} testID="delete-take" />
            ) : (
              <SideButton icon="list" label={free ? 'Clips' : 'Lines'} onPress={() => setLinesOpen(true)} disabled={busy} testID="lines" />
            )}
            <RecordButton phase={phase} pending={!!pending} onPress={onRecordPress} />
            <SideButton icon="check" label="Keep, next" tone="accent" onPress={keep} disabled={!pending || busy} testID="keep-next" />
          </View>
          <PressableScale
            onPress={finish}
            disabled={!finishable}
            motion="button"
            restingOpacity={finishable ? 1 : 0.4}
            accessibilityRole="button"
            accessibilityState={{ disabled: !finishable }}
            style={s.finish}
            testID="finish"
          >
            <Text variant="body" weight={600} tone="white">
              Finish and edit
            </Text>
          </PressableScale>
        </Glass>
      </View>

      <RecorderSheets
        prefsOpen={prefsOpen}
        linesOpen={linesOpen}
        session={session}
        onPrefs={onPrefs}
        onPick={(i) => {
          onJump(i);
          setLinesOpen(false);
        }}
        onClosePrefs={() => setPrefsOpen(false)}
        onCloseLines={() => setLinesOpen(false)}
      />
    </View>
  );
}

// ---- Small parts ------------------------------------------------------------------------------

/** The recording timer: its own component, so only it re-renders four times a second. */
function Timer() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const t = setInterval(() => setElapsed((Date.now() - started) / 1000), 250);
    return () => clearInterval(t);
  }, []);
  return (
    <Text variant="secondary" weight={600} tone="white" tabular>
      {formatDuration(elapsed)}
    </Text>
  );
}

// `countdown`: each numeral scales 1.25 to 1 and fades in (300 ms), then fades out (200 ms).
function countIn(reduced: boolean): EntryExitAnimationFunction {
  return () => {
    'worklet';
    const t = { duration: 300, easing: standard, reduceMotion: ReduceMotion.Never };
    return reduced
      ? { initialValues: { opacity: 0 }, animations: { opacity: withTiming(1, { ...t, duration: 150 }) } }
      : { initialValues: { opacity: 0, transform: [{ scale: 1.25 }] }, animations: { opacity: withTiming(1, t), transform: [{ scale: withTiming(1, t) }] } };
  };
}
const countOut: EntryExitAnimationFunction = () => {
  'worklet';
  return { initialValues: { opacity: 1 }, animations: { opacity: withTiming(0, { duration: 200, easing: standard, reduceMotion: ReduceMotion.Never }) } };
};
const countMotion = { full: countIn(false), reduced: countIn(true) };

function Countdown({ n }: { n: number }) {
  const s = useStyles();
  const reduced = useReducedMotionSetting();
  return (
    <Animated.Text
      entering={native ? (reduced ? countMotion.reduced : countMotion.full) : undefined}
      exiting={native ? countOut : undefined}
      style={[s.countdown, { position: 'absolute' }]}
      accessibilityLiveRegion="assertive"
      testID="countdown"
    >
      {n}
    </Animated.Text>
  );
}

// Delete take: the card scales to 0.9 and fades, 160 ms.
const previewOut: EntryExitAnimationFunction = () => {
  'worklet';
  const t = { duration: 160, easing: Easing.bezier(0.4, 0, 1, 1), reduceMotion: ReduceMotion.System };
  return { initialValues: { opacity: 1, transform: [{ scale: 1 }] }, animations: { opacity: withTiming(0, t), transform: [{ scale: withTiming(0.9, t) }] } };
};
const previewIn: EntryExitAnimationFunction = () => {
  'worklet';
  const t = { duration: 200, easing: standard, reduceMotion: ReduceMotion.System };
  return { initialValues: { opacity: 0, transform: [{ scale: 0.96 }] }, animations: { opacity: withTiming(1, t), transform: [{ scale: withTiming(1, t) }] } };
};

/** The take just recorded, playing in a 9:16 card at the centre with "Take 2 · 0:08". Tap to play it again. */
const TakePreview = memo(function TakePreview({ uri, label }: { uri: string; label: string }) {
  const s = useStyles();
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
    p.play();
  });
  return (
    <Animated.View entering={native ? previewIn : undefined} exiting={native && !prefersReducedMotion() ? previewOut : undefined}>
      <Pressable
        onPress={() => {
          player.currentTime = 0;
          player.play();
        }}
        accessibilityRole="button"
        accessibilityLabel={`Play the take again, ${label}`}
        style={s.preview}
        testID="take-preview"
      >
        <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="cover" nativeControls={false} />
        <View style={s.previewLabel}>
          <SymbolIcon name="play" size={11} color="#FFFFFF" />
          <Text variant="label" weight={600} tone="white" tabular>
            {label}
          </Text>
        </View>
      </Pressable>
    </Animated.View>
  );
});

/** A 44pt glass circle over the camera (close, flip, Aa). */
function CamButton({ icon, glyph, label, onPress, disabled, testID }: { icon?: IconName; glyph?: string; label: string; onPress: () => void; disabled?: boolean; testID?: string }) {
  const s = useStyles();
  return (
    <PressableScale onPress={onPress} disabled={disabled} motion="icon" restingOpacity={disabled ? 0.5 : 1} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }} testID={testID}>
      <Glass kind="button" appearance="dark" interactive style={s.circle}>
        {icon ? (
          <SymbolIcon name={icon} size={Platform.OS === 'ios' ? 17 : 20} strokeWidth={2.2} color="#FFFFFF" />
        ) : (
          <Text variant="body" weight={600} tone="white">
            {glyph}
          </Text>
        )}
      </Glass>
    </PressableScale>
  );
}

/**
 * A 52pt circle with its label under it, inside the control panel (content on the panel's
 * glass, never glass on glass). "Keep, next" is accent-filled when it can be pressed.
 */
function SideButton({ icon, label, tone, onPress, disabled, testID }: { icon: IconName; label: string; tone?: 'cut' | 'accent'; onPress: () => void; disabled?: boolean; testID?: string }) {
  const s = useStyles();
  const c = useColors();
  const on = tone === 'accent' && !disabled;
  const fg = tone === 'cut' ? c.cut : '#FFFFFF';
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      motion="icon"
      haptic={false}
      restingOpacity={disabled ? 0.4 : 1}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={s.side}
      testID={testID}
    >
      <View style={[s.sideCircle, on && s.sideOn]}>
        <SymbolIcon name={icon} size={20} strokeWidth={2.4} color={fg} />
      </View>
      <Text variant="label" weight={500} style={{ color: tone === 'cut' ? c.cut : WHITE_70 }} numberOfLines={1}>
        {label}
      </Text>
    </PressableScale>
  );
}

// ---- Permission gate --------------------------------------------------------------------------

function PermissionGate({ perms }: { perms: ReturnType<typeof useRecorderPermissions> }) {
  const s = useStyles();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const checking = perms.camera === 'checking' || perms.microphone === 'checking';
  const denied = perms.camera === 'denied' || perms.microphone === 'denied';
  const unavailable = perms.camera === 'unavailable';
  const missing = [perms.camera !== 'granted' ? 'camera' : null, perms.microphone !== 'granted' ? 'microphone' : null].filter(Boolean).join(' and ');
  return (
    <View style={[styles.root, { paddingHorizontal: 20, justifyContent: 'center' }]} testID="permission-gate">
      <View style={[s.top, { position: 'absolute', top: Math.max(insets.top, 12) + 8, left: 0, right: 0 }]}>
        <CamButton icon="close" label="Close camera" onPress={() => (router.canGoBack() ? router.back() : router.replace('/record'))} />
      </View>
      <ThemeScope appearance="light">
        <Glass kind="panel" appearance="light" radius={28} style={s.card}>
          {checking ? (
            <ActivityIndicator color={c.accent} />
          ) : (
            <>
              <SymbolIcon name="camera" size={28} color={denied ? c.cut : c.accent} />
              <Text variant="bodyLg" center>
                {unavailable ? 'No camera here' : denied ? `Kilo can't use your ${missing}` : `Kilo needs your ${missing}`}
              </Text>
              <Text variant="secondary" tone="muted" center>
                {unavailable
                  ? 'This device or browser has no camera Kilo can use. Record in your camera app and upload the clips instead.'
                  : denied
                    ? perms.canOpenSettings
                      ? `Turn on ${missing} access for Kilo in Settings, then come back.`
                      : `Allow ${missing} for this site in your browser's site settings, then reload.`
                    : 'You record yourself reading each line. Video and sound stay on this phone until you finish and upload.'}
              </Text>
              {denied && perms.canOpenSettings ? <PillButton label="Open Settings" height={52} onPress={perms.openSettings} testID="open-settings" /> : null}
              {!denied && !unavailable ? <PillButton label={`Allow ${missing}`} height={52} onPress={() => void perms.request()} testID="allow-camera" /> : null}
              <PillButton variant="text" label="Upload clips instead" onPress={() => router.replace('/new-batch')} />
            </>
          )}
        </Glass>
      </ThemeScope>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0A0F1A' },
});
