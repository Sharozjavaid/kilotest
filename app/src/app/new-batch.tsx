import { useMemo, useState } from 'react';
import { Alert, Platform, ScrollView, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { router, usePreventRemove } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { MODE_PRESETS, type EditSettings } from '@kilo/edl';
import { getApi, getMockApi } from '@/api/client';
import { errorMessage } from '@/api/errors';
import { keys } from '@/api/queries';
import { getUploadQueue } from '@/uploads/UploadManager';
import {
  addBroll,
  countClips,
  effectiveVideoSettings,
  groupPicked,
  toCreateBatchRequest,
  uploadJobsFor,
  type DraftVideo,
  type PickedFile,
} from '@/newBatch/grouping';
import { pickFromLibrary, sampleFiles } from '@/newBatch/picker';
import { takePendingPicks } from '@/newBatch/handoff';
import { VideosEditor } from '@/components/VideosEditor';
import { ChooseVideoSheet } from '@/components/ChooseVideoSheet';
import { FOOTER_BUTTON } from '@/components/sizes';
import { formatDuration, plural } from '@/lib/format';
import { EditSwitches, HookVariations, ModeControl } from '@/components/SettingsControls';
import { StyleChooser, useStartingSettings } from '@/styles/StyleChooser';
import { PillButton, PressableScale, Screen, SymbolIcon, Text, haptic, makeStyles, radius, space, toast, useColors, useLayoutMotion } from '@/ui';

const ios = Platform.OS === 'ios';
const native = Platform.OS !== 'web';

function notify(title: string, message: string) {
  if (Platform.OS === 'web') (globalThis as { alert?: (m: string) => void }).alert?.(`${title}\n\n${message}`);
  else Alert.alert(title, message);
}

/**
 * New batch (design brief 4.4). On iOS a page sheet that opens after the photo picker, already
 * holding the clips: the strip of picked clips, Style, Kind of video, the edit toggles, B-roll,
 * hooks, and "Edit 30 videos" in the glass footer. Submitting starts the uploads and closes the
 * sheet at once (Home shows the batch arriving); Android and web go on to the Batch screen.
 */
export default function NewBatchScreen() {
  const s = useStyles();
  const qc = useQueryClient();
  // Clips picked on Home before the sheet opened (brief 3: no empty step).
  const [videos, setVideos] = useState<DraftVideo[]>(() => {
    const picks = takePendingPicks();
    return picks.length ? groupPicked(picks, []) : [];
  });
  const [settings, setSettings] = useState<EditSettings>(MODE_PRESETS.general.settings);
  // Start from the default style once styles load (until the creator changes something).
  const touched = useStartingSettings(setSettings);
  const [editorOpen, setEditorOpen] = useState(false);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [discarded, setDiscarded] = useState(false);
  const mock = !!getMockApi();

  // Swipe-to-dismiss (or Back) asks first, only when there are clips to lose.
  usePreventRemove(native && videos.length > 0 && !submitting && !discarded, ({ repeat }) => {
    Alert.alert('Discard these clips?', `${plural(videos.length, 'video')} you picked won't be edited.`, [
      { text: 'Keep editing', style: 'cancel' },
      {
        text: 'Discard',
        style: 'destructive',
        onPress: () => {
          setDiscarded(true);
          // After the re-render that lifts the prevention.
          setTimeout(repeat, 0);
        },
      },
    ]);
  });

  const clipCount = countClips(videos);
  const ownCount = videos.filter((v) => effectiveVideoSettings(settings, v).own).length;
  const brollCount = videos.reduce((n, v) => n + v.broll.length, 0);

  const pickClips = async () => {
    try {
      const files = await pickFromLibrary('videos');
      if (files.length) setVideos((v) => groupPicked(files, v));
    } catch (e) {
      notify("Couldn't open your library", errorMessage(e));
    }
  };

  const pickBrollFor = async (videoKey: string) => {
    setChooserOpen(false);
    try {
      const files: PickedFile[] = mock && Platform.OS === 'web' ? sampleFiles('media', 2) : await pickFromLibrary('media');
      if (files.length) setVideos((v) => addBroll(v, videoKey, files));
    } catch (e) {
      notify("Couldn't open your library", errorMessage(e));
    }
  };

  const onAddBroll = () => {
    if (videos.length === 0) return notify('Add clips first', 'Pick the videos to edit, then add B-roll to one of them.');
    if (videos.length === 1) return void pickBrollFor(videos[0]!.key);
    setChooserOpen(true);
  };

  const change = (next: EditSettings) => {
    touched();
    setSettings(next);
  };
  const set = <K extends keyof EditSettings>(k: K, v: EditSettings[K]) => change({ ...settings, [k]: v });

  const submit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await getApi().createBatch(toCreateBatchRequest(settings, videos));
      await getUploadQueue().enqueue(uploadJobsFor(res, videos));
      void qc.invalidateQueries({ queryKey: keys.home });
      // The one success moment of this flow: a toast with the success haptic (brief 4.4, 6).
      toast.success(`Editing ${plural(videos.length, 'video')}`, { haptic: true });
      // iOS: the sheet closes at once and Home shows the batch arriving. Elsewhere: its progress.
      if (ios && router.canGoBack()) router.back();
      else router.replace(`/batch/${res.batch.id}`);
    } catch (e) {
      // The sheet stays; the error sits under the button.
      setSubmitError(errorMessage(e));
      haptic('error');
      setSubmitting(false);
    }
  };

  const meta = videos.length ? `${plural(videos.length, 'video')} · ${plural(clipCount, 'clip')}` : undefined;
  const brollSummary = useMemo(() => {
    const withBroll = videos.filter((v) => v.broll.length);
    if (!withBroll.length) return null;
    return withBroll.map((v) => `${v.broll.length} for ${v.title}`).join(', ');
  }, [videos]);

  return (
    <Screen
      appearance="auto"
      gap={16}
      header={{ title: 'New batch', meta, close: true }}
      footerGlass
      footer={
        <>
          {submitError ? (
            <Text variant="secondary" tone="cut" center accessibilityRole="alert" testID="submit-error">
              {`Couldn't start the batch. ${submitError}`}
            </Text>
          ) : null}
          <PillButton
            label={videos.length ? `Edit ${plural(videos.length, 'video')}` : 'Edit videos'}
            onPress={submit}
            disabled={!videos.length}
            loading={submitting}
            height={FOOTER_BUTTON}
            testID="submit-batch"
          />
        </>
      }
    >
      <ClipStrip videos={videos} onPick={pickClips} onOpen={() => setEditorOpen(true)} onSample={mock ? () => setVideos((v) => groupPicked(sampleFiles('videos', 3), v)) : undefined} />

      <StyleChooser settings={settings} onPick={change} />

      <ModeControl settings={settings} onChange={change} />

      <EditSwitches settings={settings} set={set} />

      <View style={s.drop}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="body" weight={500}>
            B-roll for these videos
          </Text>
          <Text variant="label" tone="muted" numberOfLines={2}>
            {brollSummary ? `${plural(brollCount, 'shot')} added: ${brollSummary}` : 'Drop in product shots. Kilo places them.'}
          </Text>
        </View>
        <PillButton variant="secondary" surface="content" label="Add clips" height={44} onPress={onAddBroll} accessibilityLabel="Add B-roll clips" style={s.dropButton} />
      </View>

      <HookVariations settings={settings} set={set} />
      {ownCount ? (
        <PressableScale onPress={() => setEditorOpen(true)} motion="row" accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center' }} testID="own-settings-note">
          <Text variant="secondary" tone="muted">
            {ownCount === 1 ? '1 video has' : `${ownCount} videos have`} their own kind of video or hooks. <Text variant="secondary" weight={600} tone="accent">Edit videos</Text>
          </Text>
        </PressableScale>
      ) : null}

      <VideosEditor visible={editorOpen} videos={videos} batchSettings={settings} onChange={setVideos} onClose={() => setEditorOpen(false)} onAddClips={pickClips} onAddBroll={pickBrollFor} />
      <ChooseVideoSheet visible={chooserOpen} videos={videos} onChoose={(k) => void pickBrollFor(k)} onClose={() => setChooserOpen(false)} />
    </Screen>
  );
}

const THUMB_W = 64;
const THUMB_H = 114;

/**
 * The picked clips as a strip of 9:16 thumbs (64 wide, radius 10), one per video, each with its
 * length; tap one to open the per-video editor. New clips arrive with `listInsert`.
 */
function ClipStrip({ videos, onPick, onOpen, onSample }: { videos: DraftVideo[]; onPick: () => void; onOpen: () => void; onSample?: () => void }) {
  const s = useStyles();
  const c = useColors();
  const m = useLayoutMotion();
  if (videos.length === 0) {
    return (
      <View style={{ gap: 6 }}>
        <PressableScale onPress={onPick} motion="card" accessibilityRole="button" accessibilityLabel="Pick clips from your library" style={s.pickTile}>
          <SymbolIcon name="plus" size={22} strokeWidth={2.2} color={c.accent} />
          <Text variant="body" weight={600}>
            Pick clips from your library
          </Text>
          <Text variant="label" tone="muted">
            Each clip becomes its own video. You can merge them next.
          </Text>
        </PressableScale>
        {onSample ? <PillButton variant="text" label="Use sample clips (mock mode)" onPress={onSample} /> : null}
      </View>
    );
  }
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.stripScroll} contentContainerStyle={s.strip}>
      {videos.map((v) => {
        const sec = v.clips.reduce((n, cl) => n + (cl.durationSec ?? 0), 0);
        return (
          <Animated.View key={v.key} entering={m.listInsert} exiting={m.listRemove} layout={m.listLayout}>
            <PressableScale onPress={onOpen} motion="tile" accessibilityRole="button" accessibilityLabel={`${v.title}, ${plural(v.clips.length, 'clip')}. Edit videos`} style={s.stripItem}>
              <View style={s.thumb}>
                <SymbolIcon name="videos" size={18} color={c.muted} />
                {v.clips.length > 1 ? (
                  <View style={[s.badge, s.badgeTop]}>
                    <Text variant="label" weight={600} tone="white" style={s.badgeText} tabular>
                      {v.clips.length}
                    </Text>
                  </View>
                ) : null}
                {sec > 0 ? (
                  <View style={s.badge}>
                    <Text variant="label" weight={600} tone="white" style={s.badgeText} tabular>
                      {formatDuration(sec)}
                    </Text>
                  </View>
                ) : null}
              </View>
              <Text variant="label" tone="muted" numberOfLines={1} style={{ width: THUMB_W }}>
                {v.title}
              </Text>
            </PressableScale>
          </Animated.View>
        );
      })}
      <PressableScale onPress={onPick} motion="tile" accessibilityRole="button" accessibilityLabel="Pick more clips" style={s.stripItem}>
        <View style={[s.thumb, s.addThumb]}>
          <SymbolIcon name="plus" size={20} strokeWidth={2.2} color={c.accent} />
        </View>
        <Text variant="label" tone="muted" numberOfLines={1}>
          More clips
        </Text>
      </PressableScale>
    </ScrollView>
  );
}

const useStyles = makeStyles((t) => ({
  drop: {
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: t.color.dropBorder,
    backgroundColor: t.color.dropFill,
    borderRadius: radius.card,
    paddingVertical: 12,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  dropButton: { flexShrink: 0 },
  stripScroll: { marginHorizontal: -space.gutter },
  strip: { gap: 10, paddingHorizontal: space.gutter },
  stripItem: { gap: 6, width: THUMB_W },
  thumb: { width: THUMB_W, height: THUMB_H, borderRadius: 10, backgroundColor: t.color.track, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  addThumb: { backgroundColor: t.color.surface, borderWidth: 1.5, borderStyle: 'dashed', borderColor: t.color.dropBorder },
  // The duration label of a thumb (brief 5.7): a small dark capsule over the frame.
  badge: { position: 'absolute', right: 4, bottom: 4, height: 18, borderRadius: 9, paddingHorizontal: 6, justifyContent: 'center', backgroundColor: 'rgba(11,18,32,0.55)' },
  badgeTop: { bottom: undefined, top: 4, left: 4, right: undefined },
  badgeText: { fontSize: 11, lineHeight: 13 },
  pickTile: {
    height: 120,
    borderRadius: radius.card,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: t.color.dropBorder,
    backgroundColor: t.color.dropFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 16,
  },
}));
