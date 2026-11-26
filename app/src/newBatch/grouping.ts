import type { CreateBatchResponse, EditSettings, NewBrollAsset, NewClip } from '@kilo/edl';
import type { CreateBatchRequestInput } from '@/api/types';
import type { NewUploadJob } from '@/uploads/queue';

/**
 * Turning files picked from the library into the videos of a new batch. Pure, so
 * it is unit-tested. By default every picked file is its own video; the creator can
 * merge several into one video, reorder clips inside a video, split a clip back out,
 * rename videos and attach B-roll to one video.
 */

export interface PickedFile {
  /** Stable local id (asset id or uri). */
  id: string;
  uri: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  kind: 'video' | 'image';
  durationSec?: number;
}

export interface DraftVideo {
  key: string;
  title: string;
  clips: PickedFile[];
  broll: PickedFile[];
}

let keySeq = 0;
export function newKey(): string {
  keySeq += 1;
  return `v${Date.now().toString(36)}${keySeq}`;
}

/** "IMG_0042.MOV" -> "IMG 0042"; empty names become "Video n". */
export function titleFromFilename(filename: string, n: number): string {
  const base = filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (base || `Video ${n}`).slice(0, 120);
}

/** One video per picked file, appended after any videos already drafted. */
export function groupPicked(files: readonly PickedFile[], existing: readonly DraftVideo[] = [], makeKey = newKey): DraftVideo[] {
  const seen = new Set(existing.flatMap((v) => v.clips.map((c) => c.id)));
  const added = files
    .filter((f) => !seen.has(f.id))
    .map((f, i) => ({ key: makeKey(), title: titleFromFilename(f.filename, existing.length + i + 1), clips: [f], broll: [] }));
  return [...existing, ...added];
}

/** Merges the selected videos into the first of them (in list order), keeping clip order. */
export function mergeVideos(videos: readonly DraftVideo[], keys: readonly string[]): DraftVideo[] {
  const selected = videos.filter((v) => keys.includes(v.key));
  if (selected.length < 2) return [...videos];
  const target = selected[0]!;
  const merged: DraftVideo = {
    ...target,
    clips: selected.flatMap((v) => v.clips),
    broll: selected.flatMap((v) => v.broll),
  };
  const drop = new Set(selected.slice(1).map((v) => v.key));
  return videos.filter((v) => !drop.has(v.key)).map((v) => (v.key === target.key ? merged : v));
}

/** Moves a clip within a video. */
export function moveClip(videos: readonly DraftVideo[], videoKey: string, from: number, to: number): DraftVideo[] {
  return videos.map((v) => {
    if (v.key !== videoKey) return v;
    if (from < 0 || from >= v.clips.length || to < 0 || to >= v.clips.length || from === to) return v;
    const clips = [...v.clips];
    const [c] = clips.splice(from, 1);
    clips.splice(to, 0, c!);
    return { ...v, clips };
  });
}

/** Takes a clip out of a merged video into its own video, placed right after it. */
export function splitClip(videos: readonly DraftVideo[], videoKey: string, clipIndex: number, makeKey = newKey): DraftVideo[] {
  const i = videos.findIndex((v) => v.key === videoKey);
  const v = videos[i];
  if (!v || v.clips.length < 2 || !v.clips[clipIndex]) return [...videos];
  const clip = v.clips[clipIndex]!;
  const rest = { ...v, clips: v.clips.filter((_, k) => k !== clipIndex) };
  const alone: DraftVideo = { key: makeKey(), title: titleFromFilename(clip.filename, videos.length + 1), clips: [clip], broll: [] };
  return [...videos.slice(0, i), rest, alone, ...videos.slice(i + 1)];
}

export function removeClip(videos: readonly DraftVideo[], videoKey: string, clipIndex: number): DraftVideo[] {
  return videos
    .map((v) => (v.key === videoKey ? { ...v, clips: v.clips.filter((_, k) => k !== clipIndex) } : v))
    .filter((v) => v.clips.length > 0);
}

export function renameVideo(videos: readonly DraftVideo[], videoKey: string, title: string): DraftVideo[] {
  return videos.map((v) => (v.key === videoKey ? { ...v, title: title.slice(0, 120) } : v));
}

export function addBroll(videos: readonly DraftVideo[], videoKey: string, files: readonly PickedFile[]): DraftVideo[] {
  return videos.map((v) => {
    if (v.key !== videoKey) return v;
    const seen = new Set(v.broll.map((b) => b.id));
    const added = files.filter((f) => !seen.has(f.id) && (seen.add(f.id), true));
    return { ...v, broll: [...v.broll, ...added].slice(0, 30) };
  });
}

export function removeBroll(videos: readonly DraftVideo[], videoKey: string, brollId: string): DraftVideo[] {
  return videos.map((v) => (v.key === videoKey ? { ...v, broll: v.broll.filter((b) => b.id !== brollId) } : v));
}

export function countClips(videos: readonly DraftVideo[]): number {
  return videos.reduce((n, v) => n + v.clips.length, 0);
}

/** A title the server accepts (1..120 characters). */
export function cleanTitle(title: string, n: number): string {
  const t = title.trim().slice(0, 120);
  return t || `Video ${n}`;
}

export function toCreateBatchRequest(settings: EditSettings, videos: readonly DraftVideo[]): CreateBatchRequestInput {
  return {
    settings,
    videos: videos.map((v, i) => ({
      title: cleanTitle(v.title, i + 1),
      source: 'upload' as const,
      clips: v.clips.map((c): NewClip => ({ filename: c.filename, contentType: c.contentType, sizeBytes: c.sizeBytes })),
      broll: v.broll.map((b): NewBrollAsset => ({ filename: b.filename, contentType: b.contentType, sizeBytes: b.sizeBytes, kind: b.kind })),
    })),
  };
}

/** Pairs each file with the upload target the server returned for it (same order). */
export function uploadJobsFor(res: CreateBatchResponse, videos: readonly DraftVideo[]): NewUploadJob[] {
  if (res.videos.length !== videos.length) throw new Error('The server returned a different number of videos');
  const jobs: NewUploadJob[] = [];
  res.videos.forEach((rv, i) => {
    const draft = videos[i]!;
    if (rv.clips.length !== draft.clips.length || rv.broll.length !== draft.broll.length) {
      throw new Error(`The server returned different files for "${draft.title}"`);
    }
    rv.clips.forEach((c, k) => {
      const f = draft.clips[k]!;
      jobs.push({ id: c.clipId, kind: 'clip', videoId: rv.videoId, batchId: res.batch.id, fileUri: f.uri, filename: f.filename, contentType: f.contentType, sizeBytes: f.sizeBytes, target: c.upload });
    });
    rv.broll.forEach((b, k) => {
      const f = draft.broll[k]!;
      jobs.push({ id: b.assetId, kind: 'broll', videoId: rv.videoId, batchId: res.batch.id, fileUri: f.uri, filename: f.filename, contentType: f.contentType, sizeBytes: f.sizeBytes, target: b.upload });
    });
  });
  return jobs;
}
