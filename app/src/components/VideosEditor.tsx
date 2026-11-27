import { useState } from 'react';
import { Modal, TextInput, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { Image } from 'expo-image';
import { MODE_PRESETS, type EditSettings, type Mode } from '@kilo/edl';
import {
  effectiveVideoSettings,
  mergeVideos,
  moveClip,
  removeBroll,
  removeClip,
  renameVideo,
  setVideoSettings,
  splitClip,
  type DraftVideo,
} from '@/newBatch/grouping';
import { MODES } from '@/components/SettingsControls';
import { formatBytes, formatDuration, plural } from '@/lib/format';
import { Card, Header, IconButton, PillButton, PressableScale, Screen, SegmentedControl, Stepper, SymbolIcon, Text, haptic, makeStyles, radius, typeStyle, useColors, useLayoutMotion } from '@/ui';
import { FOOTER_BUTTON } from './sizes';

/**
 * Full-screen editor for the videos of a new batch: rename, reorder clips inside a
 * video, split a clip out, remove, select several videos to merge into one, and give one
 * video its own kind of video and number of openings (it follows the batch otherwise).
 */
export function VideosEditor({
  visible,
  videos,
  batchSettings,
  onChange,
  onClose,
  onAddClips,
  onAddBroll,
}: {
  visible: boolean;
  videos: DraftVideo[];
  /** The batch's settings, which every video follows unless it has its own. */
  batchSettings: EditSettings;
  onChange: (v: DraftVideo[]) => void;
  onClose: () => void;
  onAddClips: () => void;
  onAddBroll: (videoKey: string) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  // One video's settings open at a time, so the list stays calm.
  const [openSettings, setOpenSettings] = useState<string | null>(null);
  const toggleSel = (key: string) => setSelected((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]));

  const m = useLayoutMotion();
  const merge = () => {
    onChange(mergeVideos(videos, selected));
    setSelected([]);
  };

  // iOS: the native page sheet (glass grabber area, swipe down to close).
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <Screen
        appearance="auto"
        sheet
        gap={12}
        footerGlass
        footer={
          <>
            {selected.length >= 2 ? (
              <PillButton label={`Merge ${selected.length} into one video`} icon="merge" height={FOOTER_BUTTON} onPress={merge} />
            ) : (
              <PillButton label="Done" height={FOOTER_BUTTON} onPress={onClose} />
            )}
            <PillButton variant="text" label="Add more clips" icon="plus" onPress={onAddClips} />
          </>
        }
      >
        <Header title="Videos in this batch" onBack={onClose} meta={plural(videos.length, 'video')} />
        <Text variant="secondary" tone="muted">
          Each clip is its own video. Select two or more to merge them into one video, then put the clips in order.
        </Text>
        {videos.map((v, i) => (
          <Animated.View key={v.key} entering={m.listInsert} exiting={m.listRemove} layout={m.listLayout}>
          <VideoCard
            index={i}
            video={v}
            selected={selected.includes(v.key)}
            onSelect={() => toggleSel(v.key)}
            onRename={(t) => onChange(renameVideo(videos, v.key, t))}
            onMove={(from, to) => onChange(moveClip(videos, v.key, from, to))}
            onSplit={(k) => onChange(splitClip(videos, v.key, k))}
            onRemove={(k) => onChange(removeClip(videos, v.key, k))}
            onRemoveBroll={(id) => onChange(removeBroll(videos, v.key, id))}
            onAddBroll={() => onAddBroll(v.key)}
            batchSettings={batchSettings}
            settingsOpen={openSettings === v.key}
            onToggleSettings={() => setOpenSettings((k) => (k === v.key ? null : v.key))}
            onSettings={(next) => onChange(setVideoSettings(videos, v.key, batchSettings, next))}
          />
          </Animated.View>
        ))}
      </Screen>
    </Modal>
  );
}

function VideoCard({
  index,
  video,
  selected,
  onSelect,
  onRename,
  onMove,
  onSplit,
  onRemove,
  onRemoveBroll,
  onAddBroll,
  batchSettings,
  settingsOpen,
  onToggleSettings,
  onSettings,
}: {
  batchSettings: EditSettings;
  settingsOpen: boolean;
  onToggleSettings: () => void;
  /** New mode or hooks for this video; null goes back to the batch's. */
  onSettings: (next: { mode?: Mode; hooks?: number } | null) => void;
  index: number;
  video: DraftVideo;
  selected: boolean;
  onSelect: () => void;
  onRename: (t: string) => void;
  onMove: (from: number, to: number) => void;
  onSplit: (k: number) => void;
  onRemove: (k: number) => void;
  onRemoveBroll: (id: string) => void;
  onAddBroll: () => void;
}) {
  const s = useStyles();
  const c = useColors();
  const m = useLayoutMotion();
  return (
    <Card gap={10} style={selected ? s.selected : undefined}>
      <View style={s.titleRow}>
        <PressableScale
          onPress={() => {
            haptic('selection');
            onSelect();
          }}
          motion="icon"
          accessibilityRole="checkbox"
          accessibilityLabel={`Select ${video.title} to merge`}
          accessibilityState={{ checked: selected }}
          aria-checked={selected}
          style={s.check}
        >
          <View style={[s.box, selected && s.boxOn]}>{selected ? <SymbolIcon name="check" size={14} strokeWidth={2.6} color={c.onAccent} /> : null}</View>
        </PressableScale>
        <TextInput
          value={video.title}
          onChangeText={onRename}
          maxLength={120}
          placeholder={`Video ${index + 1}`}
          placeholderTextColor={c.muted}
          accessibilityLabel={`Name of video ${index + 1}`}
          style={s.titleInput}
        />
        <SymbolIcon name="pencil" size={15} color={c.muted} />
      </View>
      <VideoSettingsLine video={video} batch={batchSettings} open={settingsOpen} onToggle={onToggleSettings} onSettings={onSettings} />
      {video.clips.map((cl, k) => (
        <Animated.View key={cl.id} layout={m.listLayout} entering={m.listInsert} exiting={m.listRemove} style={[s.clip, k > 0 && s.divider]}>
          <Text variant="secondary" tone="muted" style={s.clipNo} tabular>
            {k + 1}
          </Text>
          <View style={{ flex: 1 }}>
            <Text variant="secondary" weight={500} numberOfLines={1}>
              {cl.filename}
            </Text>
            <Text variant="label" tone="muted" tabular>
              {cl.durationSec ? formatDuration(cl.durationSec) : 'Clip'}
              {cl.sizeBytes ? ` · ${formatBytes(cl.sizeBytes)}` : ''}
            </Text>
          </View>
          {video.clips.length > 1 ? (
            <>
              <IconButton glass={false} icon="chevronUp" label={`Move ${cl.filename} earlier`} disabled={k === 0} onPress={() => onMove(k, k - 1)} />
              <IconButton glass={false} icon="chevronDown" label={`Move ${cl.filename} later`} disabled={k === video.clips.length - 1} onPress={() => onMove(k, k + 1)} />
              <IconButton glass={false} icon="split" label={`Make ${cl.filename} its own video`} onPress={() => onSplit(k)} />
            </>
          ) : null}
          <IconButton glass={false} icon="close" label={`Remove ${cl.filename}`} onPress={() => onRemove(k)} />
        </Animated.View>
      ))}
      <View style={s.brollRow}>
        {video.broll.map((b) => (
          <PressableScale key={b.id} onPress={() => onRemoveBroll(b.id)} motion="chip" accessibilityRole="button" accessibilityLabel={`Remove B-roll ${b.filename}`} style={s.brollChip}>
            {b.kind === 'image' && !b.uri.startsWith('mock://') ? <Image source={{ uri: b.uri }} style={s.brollImg} /> : <SymbolIcon name="broll" size={16} color={c.muted} />}
            <Text variant="label" numberOfLines={1} style={{ maxWidth: 90 }}>
              {b.filename}
            </Text>
            <SymbolIcon name="close" size={12} color={c.muted} />
          </PressableScale>
        ))}
        <PillButton variant="secondary" surface="content" height={44} label={video.broll.length ? 'More B-roll' : 'Add B-roll'} onPress={onAddBroll} />
      </View>
    </Card>
  );
}

/**
 * "TikTok Shop · 2 hooks" under a video's name: what it will be edited with. Muted while it
 * follows the batch; tap to give it its own kind of video and number of openings.
 */
function VideoSettingsLine({
  video,
  batch,
  open,
  onToggle,
  onSettings,
}: {
  video: DraftVideo;
  batch: EditSettings;
  open: boolean;
  onToggle: () => void;
  onSettings: (next: { mode?: Mode; hooks?: number } | null) => void;
}) {
  const s = useStyles();
  const c = useColors();
  const m = useLayoutMotion();
  const eff = effectiveVideoSettings(batch, video);
  const summary = `${MODE_PRESETS[eff.mode].label} · ${eff.hooks === 1 ? '1 opening' : `${eff.hooks} hooks`}`;
  return (
    <View style={{ gap: 10 }}>
      <PressableScale
        onPress={onToggle}
        motion="chip"
        accessibilityRole="button"
        accessibilityLabel={`Settings for ${video.title}: ${summary}${eff.own ? '' : ', as the batch'}`}
        accessibilityState={{ expanded: open }}
        hitSlop={{ top: 6, bottom: 6 }}
        style={[s.settingsLine, eff.own && s.settingsOwn]}
        testID={`video-settings-${video.key}`}
      >
        <Text variant="label" weight={600} tone={eff.own ? 'accent' : 'muted'} numberOfLines={1}>
          {summary}
        </Text>
        <Text variant="label" tone="muted">
          {eff.own ? 'This video only' : 'As the batch'}
        </Text>
        <SymbolIcon name={open ? 'chevronUp' : 'chevronDown'} size={12} strokeWidth={2.2} color={c.muted} />
      </PressableScale>
      {open ? (
        <Animated.View entering={m.listInsert} style={s.settingsPanel}>
          <SegmentedControl segments={MODES} value={eff.mode} onChange={(mode) => onSettings({ mode })} accessibilityLabel={`Kind of video for ${video.title}`} />
          <View style={s.hooksRow}>
            <View style={{ flex: 1 }}>
              <Text variant="secondary" weight={500}>
                Hook variations
              </Text>
              <Text variant="label" tone="muted">
                {eff.hooks === 1 ? 'One opening' : `${eff.hooks} openings for this video`}
              </Text>
            </View>
            <Stepper value={eff.hooks} min={1} max={5} onChange={(hooks) => onSettings({ hooks })} noun="openings" />
          </View>
          {eff.own ? <PillButton variant="text" label="Use the batch's settings" onPress={() => onSettings(null)} /> : null}
        </Animated.View>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  settingsLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    minHeight: 36,
    paddingHorizontal: 12,
    borderRadius: 18,
    backgroundColor: t.color.fill,
    borderWidth: 1,
    borderColor: t.color.outline,
  },
  settingsOwn: { borderColor: t.color.accent },
  settingsPanel: { gap: 10, paddingTop: 2 },
  hooksRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  selected: { borderColor: t.color.accent, borderWidth: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  check: { width: 44, height: 44, marginLeft: -8, alignItems: 'center', justifyContent: 'center' },
  box: { width: 22, height: 22, borderRadius: 7, borderWidth: 1.5, borderColor: t.color.outline, backgroundColor: t.color.fill, alignItems: 'center', justifyContent: 'center' },
  boxOn: { backgroundColor: t.color.accent, borderColor: t.color.accent },
  titleInput: { ...typeStyle('bodyLg'), color: t.color.ink, flex: 1, minHeight: 44, paddingVertical: 0 },
  clip: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 48 },
  divider: { borderTopWidth: 1, borderTopColor: t.color.hairline },
  clipNo: { width: 20 },
  brollRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  brollChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 10,
    borderRadius: radius.md,
    backgroundColor: t.color.fill,
    borderWidth: 1,
    borderColor: t.color.outline,
  },
  brollImg: { width: 24, height: 24, borderRadius: 4 },
}));
