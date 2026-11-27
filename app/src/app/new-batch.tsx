import { useMemo, useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
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
import { VideosEditor } from '@/components/VideosEditor';
import { ChooseVideoSheet } from '@/components/ChooseVideoSheet';
import { plural } from '@/lib/format';
import { EditSwitches, HookVariations, ModeControl } from '@/components/SettingsControls';
import { StyleChooser, useStartingSettings } from '@/styles/StyleChooser';
import { Header, Icon, PillButton, Screen, Text, color, radius } from '@/ui';

function notify(title: string, message: string) {
  if (Platform.OS === 'web') (globalThis as { alert?: (m: string) => void }).alert?.(`${title}\n\n${message}`);
  else Alert.alert(title, message);
}

/** New batch (mock-up `NewBatch`). */
export default function NewBatchScreen() {
  const qc = useQueryClient();
  const [videos, setVideos] = useState<DraftVideo[]>([]);
  const [settings, setSettings] = useState<EditSettings>(MODE_PRESETS.general.settings);
  // Start from the default style once styles load (until the creator changes something).
  const touched = useStartingSettings(setSettings);
  const [editorOpen, setEditorOpen] = useState(false);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const mock = !!getMockApi();

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
    try {
      const res = await getApi().createBatch(toCreateBatchRequest(settings, videos));
      await getUploadQueue().enqueue(uploadJobsFor(res, videos));
      void qc.invalidateQueries({ queryKey: keys.home });
      router.replace(`/batch/${res.batch.id}`);
    } catch (e) {
      notify("Couldn't start the batch", errorMessage(e));
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
      gap={12}
      footer={
        <PillButton
          label={videos.length ? `Edit ${plural(videos.length, 'video')}` : 'Edit videos'}
          onPress={submit}
          disabled={!videos.length}
          loading={submitting}
          testID="submit-batch"
        />
      }
    >
      <Header title="New batch" meta={meta} />

      <VideoStrip videos={videos} onPick={pickClips} onOpen={() => setEditorOpen(true)} onSample={mock ? () => setVideos((v) => groupPicked(sampleFiles('videos', 3), v)) : undefined} />

      <StyleChooser settings={settings} onPick={change} />

      <ModeControl settings={settings} onChange={change} />

      <EditSwitches settings={settings} set={set} />

      <View style={styles.drop}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="body" weight={500}>
            B-roll for these videos
          </Text>
          <Text variant="label" tone="muted" numberOfLines={2}>
            {brollSummary ? `${plural(brollCount, 'shot')} added: ${brollSummary}` : 'Drop in product shots. Kilo places them.'}
          </Text>
        </View>
        <PillButton variant="secondary" label="Add clips" height={44} onPress={onAddBroll} accessibilityLabel="Add B-roll clips" style={styles.dropButton} />
      </View>

      <HookVariations settings={settings} set={set} />
      {ownCount ? (
        <Pressable onPress={() => setEditorOpen(true)} accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center' }} testID="own-settings-note">
          <Text variant="secondary" tone="muted">
            {ownCount === 1 ? '1 video has' : `${ownCount} videos have`} their own kind of video or hooks. <Text variant="secondary" weight={600} tone="accent">Edit videos</Text>
          </Text>
        </Pressable>
      ) : null}

      <VideosEditor visible={editorOpen} videos={videos} batchSettings={settings} onChange={setVideos} onClose={() => setEditorOpen(false)} onAddClips={pickClips} onAddBroll={pickBrollFor} />
      <ChooseVideoSheet visible={chooserOpen} videos={videos} onChoose={(k) => void pickBrollFor(k)} onClose={() => setChooserOpen(false)} />
    </Screen>
  );
}

/** The row of video tiles from the mock-up. Two videos and a "+N" tile; tap any to edit. */
function VideoStrip({ videos, onPick, onOpen, onSample }: { videos: DraftVideo[]; onPick: () => void; onOpen: () => void; onSample?: () => void }) {
  if (videos.length === 0) {
    return (
      <View style={{ gap: 6 }}>
        <Pressable onPress={onPick} accessibilityRole="button" accessibilityLabel="Pick clips from your library" style={({ pressed }) => [styles.pickTile, pressed && { opacity: 0.7 }]}>
          <Icon name="plus" size={22} color={color.accent} />
          <Text variant="body" weight={600}>
            Pick clips from your library
          </Text>
          <Text variant="label" tone="muted">
            Each clip becomes its own video. You can merge them next.
          </Text>
        </Pressable>
        {onSample ? <PillButton variant="text" label="Use sample clips (mock mode)" onPress={onSample} /> : null}
      </View>
    );
  }
  const shown = videos.slice(0, 2);
  const rest = videos.length - shown.length;
  return (
    <View style={styles.strip}>
      {shown.map((v) => (
        <Pressable key={v.key} onPress={onOpen} accessibilityRole="button" accessibilityLabel={`${v.title}, ${plural(v.clips.length, 'clip')}. Edit videos`} style={styles.stripItem}>
          <View style={styles.stripThumb}>
            <Icon name="videos" size={18} color={color.muted} />
          </View>
          <Text variant="label" tone="muted" numberOfLines={1}>
            {v.title} · {plural(v.clips.length, 'clip')}
          </Text>
        </Pressable>
      ))}
      <Pressable onPress={rest > 0 ? onOpen : onPick} accessibilityRole="button" accessibilityLabel={rest > 0 ? `${rest} more videos. Edit videos` : 'Add more clips'} style={styles.stripItem}>
        <View style={[styles.stripThumb, styles.stripMore]}>
          {rest > 0 ? (
            <Text variant="body" weight={600}>
              +{rest}
            </Text>
          ) : (
            <Icon name="plus" size={20} />
          )}
        </View>
        <Text variant="label" tone="muted" numberOfLines={1}>
          {rest > 0 ? 'more videos' : 'Add clips'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  drop: {
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: color.dropBorder,
    backgroundColor: color.dropFill,
    borderRadius: radius.card,
    paddingVertical: 12,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  dropButton: { flexShrink: 0 },
  strip: { flexDirection: 'row', gap: 8 },
  stripItem: { flex: 1, gap: 6, minHeight: 44 },
  stripThumb: { height: 64, borderRadius: radius.md, backgroundColor: color.track, alignItems: 'center', justifyContent: 'center' },
  stripMore: { backgroundColor: color.surface, borderWidth: 1, borderColor: color.hairline },
  pickTile: {
    height: 120,
    borderRadius: radius.card,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: color.dropBorder,
    backgroundColor: color.dropFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 16,
  },
});
