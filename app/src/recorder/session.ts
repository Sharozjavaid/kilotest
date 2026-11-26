import { splitScript, type CreateBatchResponse, type EditSettings, type NewBrollAsset, type NewClip } from '@kilo/edl';
import type { CreateBatchRequestInput } from '@/api/types';
import type { NewUploadJob } from '@/uploads/queue';

/**
 * A recording session: the script, the takes recorded for each line, and where the
 * creator is. Pure and serialisable, so it is unit-tested and saved as a draft that
 * survives the app closing. Functions return a new session plus any take files that
 * are no longer needed (the caller deletes them).
 *
 * - `script` mode: one line of the script per clip, with a teleprompter.
 * - `free` mode ("No script, just record"): clips back to back, no teleprompter; a
 *   new empty line is opened after each kept clip.
 */

export const MAX_CLIPS = 60;

export interface Take {
  id: string;
  /** file:// URI on device; blob: URL on web. */
  uri: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  durationSec: number;
  /** 1-based count of takes recorded for this line. */
  takeNumber: number;
  recordedAt: number;
}

export interface ScriptLine {
  key: string;
  text: string;
  /** The take that will be used for this line. */
  kept: Take | null;
  /** How many takes were recorded for this line so far (kept, deleted or replaced). */
  takesRecorded: number;
}

export type RecorderMode = 'script' | 'free';
export type Stage = 'script' | 'recording' | 'finish';
export type TextSize = 'S' | 'M' | 'L';

export interface RecorderPrefs {
  textSize: TextSize;
  /** Teleprompter auto-scroll for long lines: 0 off, 1 slow, 2 medium, 3 fast. */
  scrollSpeed: 0 | 1 | 2 | 3;
  /** Seconds of countdown before recording starts; 0 starts at once. */
  countdown: 0 | 3;
  facing: 'front' | 'back';
}

export interface RecorderSession {
  version: 1;
  id: string;
  mode: RecorderMode;
  title: string;
  stage: Stage;
  lines: ScriptLine[];
  /** The line being recorded. */
  current: number;
  /** A take just recorded, waiting for Keep or Delete. */
  pending: Take | null;
  prefs: RecorderPrefs;
  createdAt: number;
  updatedAt: number;
}

export interface Change {
  session: RecorderSession;
  /** Take files no longer referenced by the session. */
  discarded: Take[];
}

export const DEFAULT_PREFS: RecorderPrefs = { textSize: 'M', scrollSpeed: 0, countdown: 3, facing: 'front' };

let seq = 0;
export function newId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

function line(text: string, makeId: (p: string) => string): ScriptLine {
  return { key: makeId('line'), text, kept: null, takesRecorded: 0 };
}

export function newSession(mode: RecorderMode, opts: { text?: string; now?: number; makeId?: (p: string) => string } = {}): RecorderSession {
  const makeId = opts.makeId ?? newId;
  const now = opts.now ?? Date.now();
  return {
    version: 1,
    id: makeId('rec'),
    mode,
    title: '',
    stage: mode === 'free' ? 'recording' : 'script',
    lines: mode === 'free' ? [line('', makeId)] : splitScript(opts.text ?? '').map((t) => line(t, makeId)),
    current: 0,
    pending: null,
    prefs: DEFAULT_PREFS,
    createdAt: now,
    updatedAt: now,
  };
}

const touch = (s: RecorderSession, patch: Partial<RecorderSession>, now = Date.now()): RecorderSession => ({ ...s, ...patch, updatedAt: now });

// ---- Script editing --------------------------------------------------------------

/** Replaces the script with lines split from pasted text. Takes on lines whose text is unchanged are kept. */
export function setScriptText(s: RecorderSession, text: string, makeId = newId): Change {
  const next = splitScript(text);
  const pool = [...s.lines];
  const lines = next.map((t) => {
    const i = pool.findIndex((l) => l.text === t);
    if (i >= 0) return pool.splice(i, 1)[0]!;
    return line(t, makeId);
  });
  return { session: touch(s, { lines, current: Math.min(s.current, Math.max(0, lines.length - 1)) }), discarded: pool.flatMap((l) => (l.kept ? [l.kept] : [])) };
}

export function setLineText(s: RecorderSession, index: number, text: string): RecorderSession {
  if (!s.lines[index]) return s;
  return touch(s, { lines: s.lines.map((l, i) => (i === index ? { ...l, text } : l)) });
}

/** Inserts an empty line after `index` (-1 for the top). */
export function addLine(s: RecorderSession, index: number, text = '', makeId = newId): RecorderSession {
  const lines = [...s.lines];
  lines.splice(index + 1, 0, line(text, makeId));
  const current = s.current > index ? s.current + 1 : s.current;
  return touch(s, { lines, current: s.lines.length ? current : 0 });
}

export function deleteLine(s: RecorderSession, index: number): Change {
  const gone = s.lines[index];
  if (!gone) return { session: s, discarded: [] };
  const lines = s.lines.filter((_, i) => i !== index);
  const current = Math.max(0, Math.min(s.current > index ? s.current - 1 : s.current, lines.length - 1));
  const discarded = [gone.kept, index === s.current ? s.pending : null].filter((t): t is Take => !!t);
  return { session: touch(s, { lines, current, pending: index === s.current ? null : s.pending }), discarded };
}

export function moveLine(s: RecorderSession, from: number, to: number): RecorderSession {
  if (from === to || !s.lines[from] || to < 0 || to >= s.lines.length) return s;
  const lines = [...s.lines];
  const [l] = lines.splice(from, 1);
  lines.splice(to, 0, l!);
  const currentKey = s.lines[s.current]?.key;
  return touch(s, { lines, current: Math.max(0, lines.findIndex((x) => x.key === currentKey)) });
}

/** Lines that can be recorded: trimmed, empty ones dropped (script mode). */
export function cleanLines(s: RecorderSession): Change {
  if (s.mode === 'free') return { session: s, discarded: [] };
  const lines = s.lines.map((l) => ({ ...l, text: l.text.trim() }));
  const dropped = lines.filter((l) => !l.text);
  return deleteMany(s, lines, dropped);
}

function deleteMany(s: RecorderSession, lines: ScriptLine[], dropped: ScriptLine[]): Change {
  const keep = lines.filter((l) => l.text);
  const currentKey = s.lines[s.current]?.key;
  const current = Math.max(0, keep.findIndex((l) => l.key === currentKey));
  return { session: touch(s, { lines: keep, current }), discarded: dropped.flatMap((l) => (l.kept ? [l.kept] : [])) };
}

// ---- Recording -----------------------------------------------------------------------

/** From the script screen to the camera: the first line without a kept take. */
export function startRecording(s: RecorderSession): Change {
  const { session, discarded } = cleanLines(s);
  if (session.mode === 'script' && session.lines.length === 0) return { session: s, discarded: [] };
  const first = session.lines.findIndex((l) => !l.kept);
  return { session: touch(session, { stage: 'recording', current: first >= 0 ? first : Math.max(0, session.lines.length - 1) }), discarded };
}

/** A take finished recording. It waits for Keep or Delete; a take already waiting is discarded. */
export function addTake(s: RecorderSession, file: Pick<Take, 'uri' | 'filename' | 'contentType' | 'sizeBytes' | 'durationSec'>, opts: { now?: number; makeId?: (p: string) => string } = {}): Change {
  const l = s.lines[s.current];
  if (!l) return { session: s, discarded: [] };
  const takeNumber = l.takesRecorded + 1;
  const take: Take = { ...file, id: (opts.makeId ?? newId)('take'), takeNumber, recordedAt: opts.now ?? Date.now() };
  const lines = s.lines.map((x, i) => (i === s.current ? { ...x, takesRecorded: takeNumber } : x));
  return { session: touch(s, { lines, pending: take }), discarded: s.pending ? [s.pending] : [] };
}

/** Keep, next: the waiting take becomes the line's take; move to the next line still to record. */
export function keepTake(s: RecorderSession, makeId = newId): Change {
  const take = s.pending;
  const l = s.lines[s.current];
  if (!take || !l) return { session: s, discarded: [] };
  let lines = s.lines.map((x, i) => (i === s.current ? { ...x, kept: take } : x));
  let current: number;
  if (s.mode === 'free') {
    lines = [...lines, line('', makeId)];
    current = lines.length - 1;
  } else {
    current = nextToRecord(lines, s.current);
  }
  return { session: touch(s, { lines, pending: null, current }), discarded: l.kept ? [l.kept] : [] };
}

/** The next line after `from` without a kept take, wrapping to earlier ones; `from` itself when all are kept. */
export function nextToRecord(lines: readonly ScriptLine[], from: number): number {
  for (let i = from + 1; i < lines.length; i++) if (!lines[i]!.kept) return i;
  for (let i = 0; i < from; i++) if (!lines[i]!.kept) return i;
  return Math.min(from, lines.length - 1);
}

/** Delete take: throws the waiting take away; the line is recorded again. */
export function deleteTake(s: RecorderSession): Change {
  if (!s.pending) return { session: s, discarded: [] };
  return { session: touch(s, { pending: null }), discarded: [s.pending] };
}

/** Jump to any line to redo it. A take still waiting is discarded; the line's kept take stays until a new one is kept. */
export function jumpTo(s: RecorderSession, index: number): Change {
  if (!s.lines[index] || index === s.current) return { session: s, discarded: [] };
  // In free mode the open (empty) last line is only kept while it is current.
  let lines = s.lines;
  if (s.mode === 'free') {
    const last = lines[lines.length - 1];
    if (last && !last.kept && s.current === lines.length - 1 && index < lines.length - 1) lines = lines.slice(0, -1);
  }
  return { session: touch(s, { lines, current: index, pending: null }), discarded: s.pending ? [s.pending] : [] };
}

/** Back to recording after the confirm step; in free mode reopens an empty line at the end. */
export function resumeRecording(s: RecorderSession, makeId = newId): RecorderSession {
  if (s.mode === 'free') {
    const last = s.lines[s.lines.length - 1];
    const lines = last && !last.kept ? s.lines : [...s.lines, line('', makeId)];
    return touch(s, { stage: 'recording', lines, current: lines.length - 1 });
  }
  return touch(s, { stage: 'recording' });
}

export function setStage(s: RecorderSession, stage: Stage): RecorderSession {
  return touch(s, { stage });
}

export function setPrefs(s: RecorderSession, prefs: Partial<RecorderPrefs>): RecorderSession {
  return touch(s, { prefs: { ...s.prefs, ...prefs } });
}

export function setTitle(s: RecorderSession, title: string): RecorderSession {
  return touch(s, { title: title.slice(0, 120) });
}

// ---- What the screen shows -------------------------------------------------------

export type SegmentState = 'kept' | 'current' | 'todo';

/** The segmented progress bar: kept lines accent, the current line ink, the rest track. */
export function progressSegments(s: RecorderSession): SegmentState[] {
  return s.lines.map((l, i) => (i === s.current ? 'current' : l.kept ? 'kept' : 'todo'));
}

export function keptCount(s: RecorderSession): number {
  return s.lines.filter((l) => l.kept).length;
}

/** "Take 2 of this line" ("of this clip" without a script): the take waiting, or the one the next recording will be. */
export function takeLabel(s: RecorderSession): string {
  const l = s.lines[s.current];
  if (!l) return '';
  const n = s.pending ? s.pending.takeNumber : l.takesRecorded + 1;
  return `Take ${n} of this ${s.mode === 'free' ? 'clip' : 'line'}`;
}

/** "LINE 3 OF 6", or "CLIP 3" without a script. */
export function lineLabel(s: RecorderSession): string {
  if (s.mode === 'free') return `CLIP ${s.current + 1}`;
  return `LINE ${s.current + 1} OF ${s.lines.length}`;
}

export function canFinish(s: RecorderSession): boolean {
  const n = keptCount(s);
  return n >= 1 && n <= MAX_CLIPS;
}

/** Every take file the session still references. */
export function liveTakes(s: RecorderSession): Take[] {
  return [...s.lines.flatMap((l) => (l.kept ? [l.kept] : [])), ...(s.pending ? [s.pending] : [])];
}

/** A title for the video from the first line, or the date. */
export function defaultTitle(s: RecorderSession, now = new Date()): string {
  const first = s.lines.find((l) => l.text.trim())?.text.trim();
  if (first) {
    const words = first.replace(/[.!?…]+$/, '').split(/\s+/).slice(0, 6).join(' ');
    return words.slice(0, 60);
  }
  return `Recording ${now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

// ---- Finishing ---------------------------------------------------------------------

/**
 * The batch with one video: `source: 'recorder'`, the script, and one clip per kept
 * take in line order with its script line index and take number.
 */
export function buildBatchRequest(s: RecorderSession, settings: EditSettings, title?: string, broll: readonly BrollFile[] = []): CreateBatchRequestInput {
  const kept = s.lines.map((l, i) => ({ l, i })).filter(({ l }) => l.kept);
  if (!kept.length) throw new Error('Keep at least one take first.');
  if (kept.length > MAX_CLIPS) throw new Error(`A video can have at most ${MAX_CLIPS} clips.`);
  const clips: NewClip[] = kept.map(({ l, i }) => ({
    filename: l.kept!.filename,
    contentType: l.kept!.contentType,
    sizeBytes: l.kept!.sizeBytes,
    ...(s.mode === 'script' ? { scriptLineIndex: i } : {}),
    takeNumber: l.kept!.takeNumber,
  }));
  const name = (title ?? s.title).trim() || defaultTitle(s);
  return {
    settings,
    videos: [
      {
        title: name.slice(0, 120),
        source: 'recorder',
        ...(s.mode === 'script' ? { script: s.lines.map((l) => l.text) } : {}),
        clips,
        broll: broll.map((b): NewBrollAsset => ({ filename: b.filename, contentType: b.contentType, sizeBytes: b.sizeBytes, kind: b.kind })),
      },
    ],
  };
}

/** A B-roll file picked on the confirm step. */
export interface BrollFile {
  uri: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  kind: 'video' | 'image';
}

/** Upload jobs for the kept takes, paired with the targets the server returned (same order). */
export function recordingUploadJobs(res: CreateBatchResponse, s: RecorderSession, broll: readonly BrollFile[] = []): NewUploadJob[] {
  const kept = s.lines.flatMap((l) => (l.kept ? [l.kept] : []));
  const v = res.videos[0];
  if (!v || v.clips.length !== kept.length || v.broll.length !== broll.length) throw new Error('The server returned a different number of files');
  const clips = v.clips.map((c, i) => {
    const t = kept[i]!;
    // The take is the app's own file: once the server has it, it is deleted.
    return { id: c.clipId, kind: 'clip' as const, videoId: v.videoId, batchId: res.batch.id, fileUri: t.uri, filename: t.filename, contentType: t.contentType, sizeBytes: t.sizeBytes, target: c.upload, deleteAfterUpload: true };
  });
  const assets = v.broll.map((b, i) => {
    const f = broll[i]!;
    return { id: b.assetId, kind: 'broll' as const, videoId: v.videoId, batchId: res.batch.id, fileUri: f.uri, filename: f.filename, contentType: f.contentType, sizeBytes: f.sizeBytes, target: b.upload };
  });
  return [...clips, ...assets];
}

// ---- Drafts -------------------------------------------------------------------------

export function serializeDraft(s: RecorderSession): string {
  return JSON.stringify(s);
}

function isTake(t: unknown): t is Take {
  const x = t as Take;
  return !!x && typeof x.uri === 'string' && typeof x.filename === 'string' && typeof x.takeNumber === 'number' && typeof x.sizeBytes === 'number';
}

/**
 * Restores a saved draft. Returns null when it is not a draft this version understands.
 * Takes whose file no longer exists (a web blob after a reload, a cleared cache) are
 * dropped and counted in `lost`; the script and the rest stay.
 */
export function restoreDraft(raw: string | null, fileExists: (uri: string) => boolean): { session: RecorderSession; lost: number } | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const d = data as Partial<RecorderSession>;
  if (!d || d.version !== 1 || (d.mode !== 'script' && d.mode !== 'free') || !Array.isArray(d.lines) || typeof d.id !== 'string') return null;
  let lost = 0;
  const check = (t: unknown): Take | null => {
    if (!isTake(t)) return null;
    if (fileExists(t.uri)) return t;
    lost += 1;
    return null;
  };
  const lines: ScriptLine[] = d.lines
    .filter((l): l is ScriptLine => !!l && typeof (l as ScriptLine).text === 'string' && typeof (l as ScriptLine).key === 'string')
    .map((l) => ({ key: l.key, text: l.text, kept: check(l.kept), takesRecorded: Number.isInteger(l.takesRecorded) ? l.takesRecorded : 0 }));
  const pending = check(d.pending);
  const stage: Stage = d.stage === 'finish' || d.stage === 'recording' || d.stage === 'script' ? d.stage : 'script';
  const session: RecorderSession = {
    version: 1,
    id: d.id,
    mode: d.mode,
    title: typeof d.title === 'string' ? d.title : '',
    stage: d.mode === 'free' && stage === 'script' ? 'recording' : stage,
    lines: d.mode === 'free' && lines.length === 0 ? [{ key: newId('line'), text: '', kept: null, takesRecorded: 0 }] : lines,
    current: Math.max(0, Math.min(Number.isInteger(d.current) ? d.current! : 0, Math.max(0, lines.length - 1))),
    pending,
    prefs: { ...DEFAULT_PREFS, ...(d.prefs ?? {}) },
    createdAt: typeof d.createdAt === 'number' ? d.createdAt : Date.now(),
    updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : Date.now(),
  };
  return { session, lost };
}

/** Whether a draft is worth offering to resume. */
export function hasProgress(s: RecorderSession): boolean {
  return s.lines.some((l) => l.kept || (s.mode === 'script' && l.text.trim())) || !!s.pending;
}
