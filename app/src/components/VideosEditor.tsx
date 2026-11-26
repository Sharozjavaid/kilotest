import { useState } from 'react';
import { Modal, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import {
  mergeVideos,
  moveClip,
  removeBroll,
  removeClip,
  renameVideo,
  splitClip,
  type DraftVideo,
} from '@/newBatch/grouping';
import { formatBytes, formatDuration, plural } from '@/lib/format';
import { Card, Header, Icon, IconButton, PillButton, Screen, Text, color, radius, typeStyle } from '@/ui';

/**
 * Full-screen editor for the videos of a new batch: rename, reorder clips inside a
 * video, split a clip out, remove, and select several videos to merge into one.
 */
export function VideosEditor({
  visible,
  videos,
  onChange,
  onClose,
  onAddClips,
  onAddBroll,
}: {
  visible: boolean;
  videos: DraftVideo[];
  onChange: (v: DraftVideo[]) => void;
  onClose: () => void;
  onAddClips: () => void;
  onAddBroll: (videoKey: string) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const toggleSel = (key: string) => setSelected((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]));

  const merge = () => {
    onChange(mergeVideos(videos, selected));
    setSelected([]);
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <Screen
        gap={12}
        footer={
          <>
            {selected.length >= 2 ? (
              <PillButton label={`Merge ${selected.length} into one video`} icon="merge" onPress={merge} />
            ) : (
              <PillButton label="Done" onPress={onClose} />
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
          <VideoCard
            key={v.key}
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
          />
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
}: {
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
  return (
    <Card gap={10} style={selected ? styles.selected : undefined}>
      <View style={styles.titleRow}>
        <Pressable
          onPress={onSelect}
          accessibilityRole="checkbox"
          accessibilityLabel={`Select ${video.title} to merge`}
          accessibilityState={{ checked: selected }}
            aria-checked={selected}
          style={styles.check}
        >
          <View style={[styles.box, selected && styles.boxOn]}>{selected ? <Icon name="check" size={16} color={color.white} /> : null}</View>
        </Pressable>
        <TextInput
          value={video.title}
          onChangeText={onRename}
          maxLength={120}
          placeholder={`Video ${index + 1}`}
          placeholderTextColor={color.muted}
          accessibilityLabel={`Name of video ${index + 1}`}
          style={styles.titleInput}
        />
        <Icon name="pencil" size={16} color={color.muted} />
      </View>
      {video.clips.map((c, k) => (
        <View key={c.id} style={[styles.clip, k > 0 && styles.divider]}>
          <Text variant="secondary" tone="muted" style={styles.clipNo}>
            {k + 1}
          </Text>
          <View style={{ flex: 1 }}>
            <Text variant="secondary" weight={500} numberOfLines={1}>
              {c.filename}
            </Text>
            <Text variant="label" tone="muted">
              {c.durationSec ? formatDuration(c.durationSec) : 'Clip'}
              {c.sizeBytes ? ` · ${formatBytes(c.sizeBytes)}` : ''}
            </Text>
          </View>
          {video.clips.length > 1 ? (
            <>
              <IconButton glass={false} icon="chevronUp" label={`Move ${c.filename} earlier`} disabled={k === 0} onPress={() => onMove(k, k - 1)} />
              <IconButton glass={false} icon="chevronDown" label={`Move ${c.filename} later`} disabled={k === video.clips.length - 1} onPress={() => onMove(k, k + 1)} />
              <IconButton glass={false} icon="split" label={`Make ${c.filename} its own video`} onPress={() => onSplit(k)} />
            </>
          ) : null}
          <IconButton glass={false} icon="close" label={`Remove ${c.filename}`} onPress={() => onRemove(k)} />
        </View>
      ))}
      <View style={styles.brollRow}>
        {video.broll.map((b) => (
          <Pressable key={b.id} onPress={() => onRemoveBroll(b.id)} accessibilityRole="button" accessibilityLabel={`Remove B-roll ${b.filename}`} style={styles.brollChip}>
            {b.kind === 'image' && !b.uri.startsWith('mock://') ? <Image source={{ uri: b.uri }} style={styles.brollImg} /> : <Icon name="broll" size={16} color={color.muted} />}
            <Text variant="label" numberOfLines={1} style={{ maxWidth: 90 }}>
              {b.filename}
            </Text>
            <Icon name="close" size={14} color={color.muted} />
          </Pressable>
        ))}
        <PillButton variant="secondary" height={44} label={video.broll.length ? 'More B-roll' : 'Add B-roll'} onPress={onAddBroll} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  selected: { borderColor: color.accent, borderWidth: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  check: { width: 44, height: 44, marginLeft: -8, alignItems: 'center', justifyContent: 'center' },
  box: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: color.outline, backgroundColor: color.white, alignItems: 'center', justifyContent: 'center' },
  boxOn: { backgroundColor: color.accent, borderColor: color.accent },
  titleInput: { ...typeStyle('bodyLg'), color: color.ink, flex: 1, minHeight: 44, paddingVertical: 0 },
  clip: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 48 },
  divider: { borderTopWidth: 1, borderTopColor: color.hairline },
  clipNo: { width: 20 },
  brollRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  brollChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 10,
    borderRadius: radius.md,
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: color.hairline,
  },
  brollImg: { width: 24, height: 24, borderRadius: 4 },
});
