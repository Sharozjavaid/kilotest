import { useMemo, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { getUploadQueue, useUploadJobs, useUploadsOffline } from '@/uploads/UploadManager';
import { PressableScale } from './PressableScale';
import { ProgressRing } from './controls';
import { Glass } from './Glass';
import { Text } from './type';
import { makeStyles } from './theme';
import { hasActiveUploads, uploadSummary, uploadSummaryLine } from './uploadSummary';

/**
 * True while this phone is sending files. Re-renders only when that flips (not on every
 * progress tick), so the tab layout can mount the accessory without re-rendering per byte.
 */
export function useHasActiveUploads(): boolean {
  const q = getUploadQueue();
  return useSyncExternalStore(
    (fn) => q.subscribe(fn),
    () => hasActiveUploads(q.getJobs()),
    () => false,
  );
}

const useStyles = makeStyles(() => ({
  row: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, minHeight: 44 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, minHeight: 36 },
  text: { flex: 1 },
  capsule: { flexDirection: 'row', alignItems: 'center', gap: 10, height: 44, paddingHorizontal: 14, alignSelf: 'center', minWidth: 220 },
}));

export interface UploadAccessoryProps {
  /**
   * - `regular`: the iOS 26 bottom accessory above the tab bar (ring 20, line, percentage).
   * - `inline`: the same beside a minimised tab bar (ring and percentage only).
   * - `capsule`: a 44pt glass capsule, for where there is no bottom accessory (iOS before 26,
   *   Android, web): place it above the tab bar yourself.
   */
  placement?: 'regular' | 'inline' | 'capsule';
}

/**
 * The uploads accessory of the design brief (section 3): while the phone sends files, a 20pt
 * ring, "Uploading 12 of 30" and the percentage. Tap opens the batch. Renders nothing when
 * no file is on its way. Subscribes to the queue itself, so only this leaf re-renders per tick.
 */
export function UploadAccessory({ placement = 'regular' }: UploadAccessoryProps) {
  const s = useStyles();
  const jobs = useUploadJobs();
  const offline = useUploadsOffline();
  const summary = useMemo(() => uploadSummary(jobs), [jobs]);
  if (!summary) return null;
  const pct = Math.round(summary.fraction * 100);
  const line = uploadSummaryLine(summary, offline);
  const open = () => {
    if (summary.batchId) router.push(`/batch/${summary.batchId}`);
  };
  const ring = <ProgressRing value={summary.fraction} size={20} tone={offline ? 'cut' : 'accent'} />;
  const label = `${line}, ${pct}%`;

  if (placement === 'inline') {
    return (
      <PressableScale onPress={open} motion="row" accessibilityRole="button" accessibilityLabel={label} style={s.inline}>
        {ring}
        <Text variant="secondary" weight={600} tabular>
          {pct}%
        </Text>
      </PressableScale>
    );
  }

  const content = (
    <>
      {ring}
      <Text variant="secondary" weight={500} numberOfLines={1} style={s.text} tabular>
        {line}
      </Text>
      <Text variant="secondary" weight={600} tone="muted" tabular>
        {pct}%
      </Text>
    </>
  );

  if (placement === 'capsule') {
    return (
      <PressableScale onPress={open} motion="button" accessibilityRole="button" accessibilityLabel={label}>
        <Glass kind="button" style={s.capsule}>
          {content}
        </Glass>
      </PressableScale>
    );
  }

  // The system draws the accessory's glass; Kilo draws only the content.
  return (
    <View style={{ flex: 1 }}>
      <PressableScale onPress={open} motion="row" accessibilityRole="button" accessibilityLabel={label} style={s.row}>
        {content}
      </PressableScale>
    </View>
  );
}
