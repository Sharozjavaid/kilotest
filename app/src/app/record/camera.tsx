import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Modal, Pressable, ScrollView, StyleSheet, View, type ScrollViewInstance } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useVideoPlayer, VideoView } from 'expo-video';
import { RecorderCamera, useRecorderPermissions } from '@/recorder/camera/RecorderCamera';
import type { CaptureInfo, RecorderCameraHandle } from '@/recorder/camera/types';
import { fpsLabel, isFullQuality, resolutionLabel } from '@/recorder/camera/capture';
import {
  addTake,
  canFinish,
  deleteTake,
  jumpTo,
  keepTake,
  keptCount,
  lineLabel,
  progressSegments,
  setPrefs,
  setStage,
  takeLabel,
  type RecorderPrefs,
  type RecorderSession,
} from '@/recorder/session';
import { loadRecorder, updateRecorder, useRecorder } from '@/recorder/store';
import { formatDuration, plural } from '@/lib/format';
import { Card, Icon, PillButton, SegmentedControl, Text, accentGloss, color, fontFamily, radius, shadow } from '@/ui';

/** Teleprompter type sizes: current line / next line. */
const TEXT_SIZES: Record<RecorderPrefs['textSize'], { line: number; next: number }> = {
  S: { line: 22, next: 15 },
  M: { line: 26, next: 17 },
  L: { line: 32, next: 19 },
};
/** Auto-scroll speeds, px per second. */
const SCROLL_PX: Record<RecorderPrefs['scrollSpeed'], number> = { 0: 0, 1: 14, 2: 24, 3: 36 };

type Phase = 'idle' | 'countdown' | 'recording' | 'saving';

/** Record with script, step 2: the camera with the teleprompter (mock-up `Record`). */
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
  if (!loaded || !session) return <View style={styles.root} />;
  return <Recorder session={session} />;
}

function Recorder({ session }: { session: RecorderSession }) {
  const perms = useRecorderPermissions();
  const granted = perms.camera === 'granted' && perms.microphone === 'granted';
  if (!granted) return <PermissionGate perms={perms} />;
  return <RecorderBody session={session} />;
}

function RecorderBody({ session }: { session: RecorderSession }) {
  const insets = useSafeAreaInsets();
  const cam = useRef<RecorderCameraHandle>(null);
  const [info, setInfo] = useState<CaptureInfo | null>(null);
  const [camError, setCamError] = useState<string | null>(null);
  const [camKey, setCamKey] = useState(0);
  const [phase, setPhase] = useState<Phase>('idle');
  const [count, setCount] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [linesOpen, setLinesOpen] = useState(false);
  const [appActive, setAppActive] = useState(true);
  const countdownToken = useRef(0);

  // Pause the camera in the background; a recording in progress is stopped and kept as a take.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setAppActive(s === 'active'));
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (phase !== 'recording') return;
    const started = Date.now();
    setElapsed(0);
    const t = setInterval(() => setElapsed((Date.now() - started) / 1000), 250);
    return () => clearInterval(t);
  }, [phase]);

  const free = session.mode === 'free';
  const line = session.lines[session.current];
  const next = session.lines[session.current + 1];
  const pending = session.pending;
  const busy = phase !== 'idle';
  const sizes = TEXT_SIZES[session.prefs.textSize];

  const start = async () => {
    setCamError(null);
    if (session.prefs.countdown > 0) {
      const token = ++countdownToken.current;
      setPhase('countdown');
      for (let i = session.prefs.countdown; i > 0; i--) {
        setCount(i);
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
      updateRecorder((s) => addTake(s, file));
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

  const close = async () => {
    countdownToken.current += 1;
    if (phase === 'recording') await cam.current?.cancel();
    if (router.canGoBack()) router.back();
    else router.replace('/record');
  };

  const finish = () => {
    updateRecorder((s) => setStage(s, 'finish'));
    router.push('/record/finish');
  };

  const kept = keptCount(session);
  const segments = progressSegments(session);
  const quality = info ? isFullQuality(info) : true;

  return (
    <View style={styles.root} testID="recorder">
      <RecorderCamera
        key={`${camKey}-${session.prefs.facing}`}
        ref={cam}
        facing={session.prefs.facing}
        active={appActive}
        onCaptureInfo={setInfo}
        onError={setCamError}
        style={StyleSheet.absoluteFill}
      />

      {/* Top controls */}
      <View style={[styles.top, { paddingTop: Math.max(insets.top, 20) }]}>
        <GlassButton icon="close" label="Close camera" onPress={() => void close()} testID="close-camera" />
        <View style={styles.badge} accessibilityLabel={info ? `Recording at ${fpsLabel(info.fps)}, ${resolutionLabel(info)}` : 'Starting camera'} testID="capture-badge">
          {phase === 'recording' ? (
            <>
              <View style={styles.recDot} />
              <Text variant="secondary" weight={600} style={{ fontVariant: ['tabular-nums'] }}>
                {formatDuration(elapsed)}
              </Text>
            </>
          ) : null}
          {info ? (
            <>
              <Text variant="secondary" weight={600} tone={quality ? 'accent' : 'cut'}>
                {fpsLabel(info.fps)}
              </Text>
              <Text variant="secondary" weight={600} tone="muted">
                {resolutionLabel(info)}
              </Text>
            </>
          ) : (
            <Text variant="secondary" weight={600} tone="muted">
              Starting…
            </Text>
          )}
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <GlassButton icon="flip" label={`Switch to the ${session.prefs.facing === 'front' ? 'back' : 'front'} camera`} disabled={busy} onPress={() => updateRecorder((s) => setPrefs(s, { facing: s.prefs.facing === 'front' ? 'back' : 'front' }))} testID="flip-camera" />
          <Pressable onPress={() => setPrefsOpen(true)} accessibilityRole="button" accessibilityLabel="Script size, scroll speed and countdown" style={({ pressed }) => [styles.glassButton, pressed && { opacity: 0.7 }]} testID="text-size">
            <Text variant="body" weight={600}>
              Aa
            </Text>
          </Pressable>
        </View>
      </View>

      {/* Teleprompter */}
      {free ? (
        <View style={styles.freeChip} testID="free-chip">
          <Text variant="label" weight={600} tone="accent" style={{ letterSpacing: 0.4 }}>
            {lineLabel(session)}
          </Text>
          <Text variant="label" tone="muted">
            No script
          </Text>
        </View>
      ) : line ? (
        <Teleprompter session={session} sizes={sizes} recording={phase === 'recording'} lineText={line.text} nextText={next?.text} />
      ) : null}

      {!quality && info && phase === 'idle' ? (
        <View style={styles.notice} testID="quality-notice">
          <Text variant="label" tone="white" center>
            This camera gives {fpsLabel(info.fps)} at {resolutionLabel(info)}. Kilo edits it as it is.
          </Text>
        </View>
      ) : null}

      <View style={styles.middle} pointerEvents="box-none">
        {phase === 'countdown' ? (
          <Text weight={700} style={styles.countdown} accessibilityLiveRegion="assertive" testID="countdown">
            {count}
          </Text>
        ) : null}
        {camError ? (
          <Card gap={8} style={styles.errorCard}>
            <Text variant="body" weight={600}>
              The camera stopped
            </Text>
            <Text variant="secondary" tone="muted">
              {camError}
            </Text>
            <PillButton variant="secondary" height={44} label="Try again" icon="refresh" onPress={() => { setCamError(null); setCamKey((k) => k + 1); }} />
          </Card>
        ) : null}
        {pending && phase === 'idle' && !camError ? <TakePreview key={pending.id} uri={pending.uri} label={`Take ${pending.takeNumber} · ${formatDuration(pending.durationSec)}`} /> : null}
      </View>

      {/* Bottom sheet */}
      <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 24) }]}>
        <View style={{ gap: 8 }}>
          <View style={styles.segments} accessibilityLabel={`${plural(kept, free ? 'clip' : 'line')} kept`}>
            {segments.map((st, i) => (
              <Pressable
                key={session.lines[i]!.key}
                onPress={() => updateRecorder((s) => jumpTo(s, i))}
                disabled={busy || i === session.current}
                accessibilityRole="button"
                accessibilityLabel={`${free ? 'Clip' : 'Line'} ${i + 1}, ${st === 'kept' ? 'kept' : st === 'current' ? 'recording now' : 'to record'}${st === 'kept' ? '. Redo it' : ''}`}
                style={styles.segHit}
                testID={`segment-${i}`}
              >
                <View style={[styles.seg, { backgroundColor: st === 'kept' ? color.accent : st === 'current' ? color.ink : color.track }]} />
              </Pressable>
            ))}
          </View>
          <View style={styles.counters}>
            <Text variant="secondary" tone="muted" testID="kept-count">
              {plural(kept, free ? 'clip' : 'line')} kept
            </Text>
            <Text variant="secondary" tone="muted" testID="take-label">
              {takeLabel(session)}
            </Text>
          </View>
        </View>

        <View style={styles.controls}>
          {pending ? (
            <SideButton icon="trash" label="Delete take" tone="cut" onPress={() => updateRecorder(deleteTake)} disabled={busy} testID="delete-take" />
          ) : (
            <SideButton icon="list" label={free ? 'Clips' : 'Lines'} tone="ink" onPress={() => setLinesOpen(true)} disabled={busy} testID="lines" />
          )}
          <RecordButton phase={phase} onPress={onRecordPress} again={!!pending} />
          <SideButton icon="check" label="Keep, next" tone="primary" onPress={() => updateRecorder((s) => keepTake(s))} disabled={!pending || busy} testID="keep-next" />
        </View>

        <Pressable
          onPress={finish}
          disabled={!canFinish(session) || busy}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canFinish(session) || busy }}
          style={({ pressed }) => [styles.finish, (!canFinish(session) || busy) && { opacity: 0.4 }, pressed && { opacity: 0.6 }]}
          testID="finish"
        >
          <Text variant="body" weight={600}>
            Finish and edit
          </Text>
        </Pressable>
      </View>

      <PrefsSheet visible={prefsOpen} prefs={session.prefs} onChange={(p) => updateRecorder((s) => setPrefs(s, p))} onClose={() => setPrefsOpen(false)} />
      <LinesSheet visible={linesOpen} session={session} onPick={(i) => { updateRecorder((s) => jumpTo(s, i)); setLinesOpen(false); }} onClose={() => setLinesOpen(false)} />
    </View>
  );
}

// ---- Teleprompter ---------------------------------------------------------------------

function Teleprompter({ session, sizes, recording, lineText, nextText }: { session: RecorderSession; sizes: { line: number; next: number }; recording: boolean; lineText: string; nextText?: string }) {
  const scroll = useRef<ScrollViewInstance>(null);
  const y = useRef(0);
  const speed = SCROLL_PX[session.prefs.scrollSpeed];
  useEffect(() => {
    y.current = 0;
    scroll.current?.scrollTo({ y: 0, animated: false });
  }, [lineText, recording]);
  useEffect(() => {
    if (!recording || !speed) return;
    // Hold the first words for a moment, then roll at the chosen speed.
    let t: ReturnType<typeof setInterval> | null = null;
    const delay = setTimeout(() => {
      t = setInterval(() => {
        y.current += speed / 20;
        scroll.current?.scrollTo({ y: y.current, animated: false });
      }, 50);
    }, 1200);
    return () => {
      clearTimeout(delay);
      if (t) clearInterval(t);
    };
  }, [recording, speed]);
  return (
    <View style={styles.panel} testID="teleprompter">
      <Text variant="label" weight={600} tone="accent" style={{ letterSpacing: 0.4 }} testID="line-label">
        {lineLabel(session)}
      </Text>
      <ScrollView ref={scroll} style={{ maxHeight: sizes.line * 1.25 * 5 }} scrollEnabled={!recording || !speed} showsVerticalScrollIndicator={false}>
        <Text style={{ fontFamily: fontFamily[600], fontSize: sizes.line, lineHeight: sizes.line * 1.25, letterSpacing: -0.5, color: color.ink }} testID="current-line">
          {lineText}
        </Text>
      </ScrollView>
      {nextText ? (
        <Text style={{ fontFamily: fontFamily[400], fontSize: sizes.next, lineHeight: sizes.next * 1.35, color: color.muted }} numberOfLines={2}>
          Next: {nextText}
        </Text>
      ) : (
        <Text style={{ fontFamily: fontFamily[400], fontSize: sizes.next, lineHeight: sizes.next * 1.35, color: color.muted }}>Last line</Text>
      )}
    </View>
  );
}

// ---- Take playback ----------------------------------------------------------------------

function TakePreview({ uri, label }: { uri: string; label: string }) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
    p.play();
  });
  return (
    <Pressable
      onPress={() => {
        player.currentTime = 0;
        player.play();
      }}
      accessibilityRole="button"
      accessibilityLabel={`Play the take again, ${label}`}
      style={styles.preview}
      testID="take-preview"
    >
      <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="cover" nativeControls={false} />
      <View style={styles.previewLabel}>
        <Icon name="play" size={12} color={color.white} />
        <Text variant="label" weight={600} tone="white">
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

// ---- Buttons ------------------------------------------------------------------------------

function GlassButton({ icon, label, onPress, disabled, testID }: { icon: 'close' | 'flip'; label: string; onPress: () => void; disabled?: boolean; testID?: string }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [styles.glassButton, (pressed || disabled) && { opacity: disabled ? 0.5 : 0.7 }]} testID={testID}>
      <Icon name={icon} size={20} strokeWidth={2.2} />
    </Pressable>
  );
}

function SideButton({ icon, label, tone, onPress, disabled, testID }: { icon: 'trash' | 'check' | 'list'; label: string; tone: 'cut' | 'ink' | 'primary'; onPress: () => void; disabled?: boolean; testID?: string }) {
  const primary = tone === 'primary';
  const fg = primary ? color.white : tone === 'cut' ? color.cut : color.ink;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [styles.side, primary ? shadow.gloss : styles.sideOutline, disabled && { opacity: 0.4 }, pressed && { opacity: 0.8 }]}
      testID={testID}
    >
      {primary ? <LinearGradient colors={accentGloss.colors} locations={accentGloss.locations} style={[StyleSheet.absoluteFill, { borderRadius: 20 }]} pointerEvents="none" /> : null}
      <View style={styles.sideInner}>
        <Icon name={icon} size={20} color={fg} strokeWidth={primary ? 2.4 : 2} />
        <Text variant="secondary" weight={primary ? 600 : 500} style={{ color: fg }}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

function RecordButton({ phase, onPress, again }: { phase: Phase; onPress: () => void; again: boolean }) {
  const recording = phase === 'recording';
  const label = recording ? 'Stop recording' : phase === 'countdown' ? 'Cancel countdown' : again ? 'Record this line again' : 'Record this line';
  return (
    <Pressable onPress={onPress} disabled={phase === 'saving'} accessibilityRole="button" accessibilityLabel={label} style={styles.record} testID="record">
      {phase === 'saving' ? <ActivityIndicator color={color.record} /> : <View style={recording ? styles.recordStop : styles.recordDot} />}
    </Pressable>
  );
}

// ---- Permission gate --------------------------------------------------------------------

function PermissionGate({ perms }: { perms: ReturnType<typeof useRecorderPermissions> }) {
  const insets = useSafeAreaInsets();
  const checking = perms.camera === 'checking' || perms.microphone === 'checking';
  const denied = perms.camera === 'denied' || perms.microphone === 'denied';
  const unavailable = perms.camera === 'unavailable';
  const missing = [perms.camera !== 'granted' ? 'camera' : null, perms.microphone !== 'granted' ? 'microphone' : null].filter(Boolean).join(' and ');
  return (
    <View style={[styles.root, { paddingTop: Math.max(insets.top, 20), paddingHorizontal: 20, justifyContent: 'center' }]} testID="permission-gate">
      <View style={[styles.top, { position: 'absolute', top: Math.max(insets.top, 20), left: 0, right: 0, paddingTop: 0 }]}>
        <GlassButton icon="close" label="Close camera" onPress={() => (router.canGoBack() ? router.back() : router.replace('/record'))} />
      </View>
      <Card gap={12} padding={24} style={{ backgroundColor: 'rgba(255,255,255,0.92)', alignItems: 'center' }}>
        {checking ? (
          <ActivityIndicator color={color.accent} />
        ) : (
          <>
            <Icon name="camera" size={28} color={denied ? color.cut : color.accent} />
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
      </Card>
    </View>
  );
}

// ---- Sheets -------------------------------------------------------------------------------

function BottomSheet({ visible, title, onClose, children }: { visible: boolean; title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
      <View style={{ flex: 1, justifyContent: 'flex-end', padding: 12 }} pointerEvents="box-none">
        <Card gap={14} style={{ backgroundColor: color.white, borderRadius: radius.card + 4, maxHeight: '80%' }}>
          <Text variant="titleSm">{title}</Text>
          {children}
          <PillButton label="Done" height={52} onPress={onClose} testID="sheet-done" />
        </Card>
      </View>
    </Modal>
  );
}

function PrefsSheet({ visible, prefs, onChange, onClose }: { visible: boolean; prefs: RecorderPrefs; onChange: (p: Partial<RecorderPrefs>) => void; onClose: () => void }) {
  return (
    <BottomSheet visible={visible} title="Script and recording" onClose={onClose}>
      <View style={{ gap: 6 }}>
        <Text variant="secondary" tone="muted">
          Text size
        </Text>
        <SegmentedControl
          segments={[
            { value: 'S', label: 'Small' },
            { value: 'M', label: 'Medium' },
            { value: 'L', label: 'Large' },
          ]}
          value={prefs.textSize}
          onChange={(textSize) => onChange({ textSize })}
          accessibilityLabel="Text size"
        />
      </View>
      <View style={{ gap: 6 }}>
        <Text variant="secondary" tone="muted">
          Scroll long lines while recording
        </Text>
        <SegmentedControl
          segments={[
            { value: '0', label: 'Off' },
            { value: '1', label: 'Slow' },
            { value: '2', label: 'Medium' },
            { value: '3', label: 'Fast' },
          ]}
          value={String(prefs.scrollSpeed) as '0' | '1' | '2' | '3'}
          onChange={(v) => onChange({ scrollSpeed: Number(v) as RecorderPrefs['scrollSpeed'] })}
          accessibilityLabel="Auto-scroll speed"
        />
      </View>
      <View style={{ gap: 6 }}>
        <Text variant="secondary" tone="muted">
          Countdown before recording
        </Text>
        <SegmentedControl
          segments={[
            { value: '0', label: 'Off' },
            { value: '3', label: '3 seconds' },
          ]}
          value={String(prefs.countdown) as '0' | '3'}
          onChange={(v) => onChange({ countdown: Number(v) as RecorderPrefs['countdown'] })}
          accessibilityLabel="Countdown"
        />
      </View>
    </BottomSheet>
  );
}

function LinesSheet({ visible, session, onPick, onClose }: { visible: boolean; session: RecorderSession; onPick: (i: number) => void; onClose: () => void }) {
  const free = session.mode === 'free';
  return (
    <BottomSheet visible={visible} title={free ? 'Clips' : 'Lines'} onClose={onClose}>
      <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={{ gap: 6 }}>
        {session.lines.map((l, i) => {
          const current = i === session.current;
          return (
            <Pressable
              key={l.key}
              onPress={() => onPick(i)}
              disabled={current}
              accessibilityRole="button"
              accessibilityLabel={`${free ? 'Clip' : 'Line'} ${i + 1}${l.kept ? `, kept take ${l.kept.takeNumber}` : ''}${current ? ', recording now' : ''}`}
              style={[styles.lineRow, current && { borderColor: color.ink }]}
              testID={`jump-${i}`}
            >
              <View style={[styles.lineDot, { backgroundColor: l.kept ? color.accent : current ? color.ink : color.track }]} />
              <Text variant="transcript" style={{ flex: 1 }} numberOfLines={2}>
                {free ? `Clip ${i + 1}` : l.text}
              </Text>
              <Text variant="label" tone="muted">
                {l.kept ? `Take ${l.kept.takeNumber}` : current ? 'Now' : ''}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </BottomSheet>
  );
}

const glass = 'rgba(255,255,255,0.9)';

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.cameraScrim },
  top: { paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  glassButton: { width: 44, height: 44, borderRadius: 22, backgroundColor: glass, alignItems: 'center', justifyContent: 'center' },
  badge: { height: 32, paddingHorizontal: 12, borderRadius: 16, backgroundColor: glass, flexDirection: 'row', alignItems: 'center', gap: 8 },
  recDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.record },
  panel: {
    marginTop: 16,
    marginHorizontal: 20,
    padding: 18,
    borderRadius: radius.card,
    backgroundColor: 'rgba(255,255,255,0.92)',
    boxShadow: '0 12px 32px rgba(0,0,0,0.25)',
    gap: 12,
  },
  freeChip: { marginTop: 16, alignSelf: 'center', flexDirection: 'row', gap: 8, height: 32, paddingHorizontal: 14, borderRadius: 16, backgroundColor: glass, alignItems: 'center' },
  notice: { marginTop: 10, marginHorizontal: 32, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 12, backgroundColor: 'rgba(11,18,32,0.6)' },
  middle: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  countdown: { fontSize: 96, lineHeight: 104, color: color.white, textShadowColor: 'rgba(0,0,0,0.35)', textShadowRadius: 12 },
  errorCard: { backgroundColor: 'rgba(255,255,255,0.95)', alignSelf: 'stretch' },
  preview: { position: 'absolute', right: 20, bottom: 16, width: 96, height: 170, borderRadius: radius.lg, overflow: 'hidden', borderWidth: 2, borderColor: color.white, backgroundColor: color.player },
  previewLabel: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingVertical: 5, flexDirection: 'row', gap: 4, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(11,18,32,0.55)' },
  sheet: { backgroundColor: color.white, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingTop: 16, paddingHorizontal: 20, gap: 18 },
  segments: { flexDirection: 'row', gap: 5 },
  segHit: { flex: 1, height: 20, justifyContent: 'center' },
  seg: { height: 8, borderRadius: 4 },
  counters: { flexDirection: 'row', justifyContent: 'space-between' },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  side: { width: 96, minHeight: 64, borderRadius: 20, alignItems: 'center', justifyContent: 'center', gap: 4, overflow: 'visible' },
  sideInner: { alignItems: 'center', gap: 4 },
  sideOutline: { borderWidth: 1, borderColor: color.outline, backgroundColor: color.white },
  record: { width: 84, height: 84, borderRadius: 42, borderWidth: 4, borderColor: color.ink, padding: 6, alignItems: 'center', justifyContent: 'center' },
  recordDot: { alignSelf: 'stretch', flex: 1, borderRadius: 40, backgroundColor: color.record },
  recordStop: { width: 30, height: 30, borderRadius: 7, backgroundColor: color.record },
  finish: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(11,18,32,0.45)' },
  lineRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingHorizontal: 12, borderRadius: radius.row, borderWidth: 1, borderColor: color.hairline },
  lineDot: { width: 10, height: 10, borderRadius: 5 },
});
