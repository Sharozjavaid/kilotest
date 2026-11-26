import { CreateBatchRequest, DEFAULT_SETTINGS, type CreateBatchResponse } from '@kilo/edl';
import {
  addLine,
  addTake,
  buildBatchRequest,
  canFinish,
  deleteLine,
  deleteTake,
  jumpTo,
  keepTake,
  keptCount,
  lineLabel,
  liveTakes,
  moveLine,
  newSession,
  progressSegments,
  recordingUploadJobs,
  restoreDraft,
  resumeRecording,
  serializeDraft,
  setLineText,
  setScriptText,
  startRecording,
  takeLabel,
  type RecorderSession,
} from './session';

let n = 0;
const makeId = (p: string) => `${p}-${++n}`;
const file = (name: string) => ({ uri: `file:///docs/${name}.mp4`, filename: `${name}.mp4`, contentType: 'video/mp4', sizeBytes: 1000, durationSec: 2.5 });
const SCRIPT = "Okay, I've used this every morning for two weeks. Here's what nobody tells you about it.\nIt takes ten seconds and it actually works.";

function rec(s: RecorderSession, name: string) {
  return addTake(s, file(name), { makeId, now: 1 }).session;
}

describe('script screen', () => {
  it('splits a pasted script into lines and edits, adds, deletes and reorders them', () => {
    let s = newSession('script', { text: SCRIPT, makeId, now: 0 });
    expect(s.lines.map((l) => l.text)).toEqual(["Okay, I've used this every morning for two weeks.", "Here's what nobody tells you about it.", 'It takes ten seconds and it actually works.']);
    s = setLineText(s, 1, 'Here is the secret.');
    s = addLine(s, 2, "Link's below.", makeId);
    s = moveLine(s, 3, 0);
    expect(s.lines.map((l) => l.text)).toEqual(["Link's below.", "Okay, I've used this every morning for two weeks.", 'Here is the secret.', 'It takes ten seconds and it actually works.']);
    s = deleteLine(s, 0).session;
    expect(s.lines).toHaveLength(3);
  });

  it('drops empty lines when recording starts', () => {
    let s = newSession('script', { text: 'One. Two.', makeId });
    s = addLine(s, 0, '   ', makeId);
    s = startRecording(s).session;
    expect(s.stage).toBe('recording');
    expect(s.lines.map((l) => l.text)).toEqual(['One.', 'Two.']);
  });

  it('keeps takes of unchanged lines when the script is pasted again', () => {
    let s = startRecording(newSession('script', { text: 'One. Two.', makeId })).session;
    s = keepTake(rec(s, 'a'), makeId).session;
    const r = setScriptText(s, 'One. Three.', makeId);
    expect(r.session.lines[0]!.kept?.filename).toBe('a.mp4');
    expect(r.discarded).toEqual([]);
  });
});

describe('recording a script', () => {
  const start = () => startRecording(newSession('script', { text: SCRIPT, makeId })).session;

  it('records, keeps and moves on; counts takes per line', () => {
    let s = start();
    expect(lineLabel(s)).toBe('LINE 1 OF 3');
    expect(takeLabel(s)).toBe('Take 1 of this line');
    s = rec(s, 'l1t1');
    expect(s.pending?.takeNumber).toBe(1);
    s = keepTake(s).session;
    expect(s.current).toBe(1);
    expect(progressSegments(s)).toEqual(['kept', 'current', 'todo']);
    expect(keptCount(s)).toBe(1);
  });

  it('delete take throws it away and the next take is take 2', () => {
    let s = start();
    s = rec(s, 'l1t1');
    const d = deleteTake(s);
    expect(d.discarded.map((t) => t.filename)).toEqual(['l1t1.mp4']);
    s = d.session;
    expect(s.pending).toBeNull();
    expect(takeLabel(s)).toBe('Take 2 of this line');
    s = rec(s, 'l1t2');
    expect(s.pending?.takeNumber).toBe(2);
  });

  it('recording again over a waiting take discards the waiting one', () => {
    let s = rec(start(), 'x1');
    const r = addTake(s, file('x2'), { makeId });
    expect(r.discarded.map((t) => t.filename)).toEqual(['x1.mp4']);
    s = r.session;
    expect(s.pending?.takeNumber).toBe(2);
  });

  it('jumps back to redo an earlier line and replaces its take only when the new one is kept', () => {
    let s = start();
    s = keepTake(rec(s, 'l1'), makeId).session;
    s = keepTake(rec(s, 'l2'), makeId).session;
    s = keepTake(rec(s, 'l3'), makeId).session;
    expect(keptCount(s)).toBe(3);
    s = jumpTo(s, 0).session;
    expect(s.current).toBe(0);
    expect(takeLabel(s)).toBe('Take 2 of this line');
    s = rec(s, 'l1-redo');
    expect(s.lines[0]!.kept?.filename).toBe('l1.mp4');
    const k = keepTake(s, makeId);
    expect(k.discarded.map((t) => t.filename)).toEqual(['l1.mp4']);
    expect(k.session.lines[0]!.kept).toMatchObject({ filename: 'l1-redo.mp4', takeNumber: 2 });
    // All lines kept: stays put.
    expect(k.session.current).toBe(0);
    expect(liveTakes(k.session)).toHaveLength(3);
  });

  it('moves to an earlier line still to record when the last line is kept first', () => {
    let s = start();
    s = jumpTo(s, 2).session;
    s = keepTake(rec(s, 'l3'), makeId).session;
    expect(s.current).toBe(0);
  });

  it('builds the batch request: recorder source, the script, one clip per kept take in line order', () => {
    let s = start();
    s = keepTake(rec(s, 'l1'), makeId).session; // line 0, take 1
    s = deleteTake(rec(s, 'l2-bad')).session; // line 1, take 1 deleted
    s = keepTake(rec(s, 'l2'), makeId).session; // line 1, take 2
    // line 2 not recorded
    expect(canFinish(s)).toBe(true);
    const req = buildBatchRequest(s, DEFAULT_SETTINGS, '  Morning routine  ');
    expect(CreateBatchRequest.safeParse(req).success).toBe(true);
    const v = req.videos[0]!;
    expect(v).toMatchObject({ title: 'Morning routine', source: 'recorder', script: s.lines.map((l) => l.text), broll: [] });
    expect(v.clips).toEqual([
      { filename: 'l1.mp4', contentType: 'video/mp4', sizeBytes: 1000, scriptLineIndex: 0, takeNumber: 1 },
      { filename: 'l2.mp4', contentType: 'video/mp4', sizeBytes: 1000, scriptLineIndex: 1, takeNumber: 2 },
    ]);

    const res = {
      batch: { id: 'b1', createdAt: '', settings: DEFAULT_SETTINGS, total: 1, counts: {} },
      videos: [{ videoId: 'v1', broll: [], clips: ['c1', 'c2'].map((clipId) => ({ clipId, upload: { kind: 'put' as const, url: 'mock://x', headers: {}, objectKey: 'k', bucket: 'kilo' } })) }],
    } satisfies CreateBatchResponse;
    const jobs = recordingUploadJobs(res, s);
    expect(jobs.map((j) => [j.id, j.fileUri, j.videoId, j.batchId, j.kind])).toEqual([
      ['c1', 'file:///docs/l1.mp4', 'v1', 'b1', 'clip'],
      ['c2', 'file:///docs/l2.mp4', 'v1', 'b1', 'clip'],
    ]);
  });

  it('cannot finish with nothing kept', () => {
    expect(canFinish(start())).toBe(false);
    expect(() => buildBatchRequest(start(), DEFAULT_SETTINGS)).toThrow();
  });
});

describe('no script, just record', () => {
  it('records free clips back to back and builds clips without script lines', () => {
    let s = newSession('free', { makeId });
    expect(s.stage).toBe('recording');
    expect(lineLabel(s)).toBe('CLIP 1');
    expect(takeLabel(s)).toBe('Take 1 of this clip');
    s = keepTake(rec(s, 'f1'), makeId).session;
    s = keepTake(rec(s, 'f2'), makeId).session;
    expect(lineLabel(s)).toBe('CLIP 3');
    expect(progressSegments(s)).toEqual(['kept', 'kept', 'current']);
    // Redo clip 1: the open empty slot goes away while away from it.
    s = jumpTo(s, 0).session;
    expect(s.lines).toHaveLength(2);
    s = keepTake(rec(s, 'f1b'), makeId).session;
    expect(s.lines).toHaveLength(3);
    const req = buildBatchRequest(s, DEFAULT_SETTINGS, 'Free');
    expect(req.videos[0]!.script).toBeUndefined();
    expect(req.videos[0]!.clips.map((c) => [c.filename, c.scriptLineIndex, c.takeNumber])).toEqual([
      ['f1b.mp4', undefined, 2],
      ['f2.mp4', undefined, 1],
    ]);
    s = resumeRecording({ ...s, stage: 'finish' }, makeId);
    expect(s.current).toBe(s.lines.length - 1);
  });
});

describe('drafts', () => {
  it('resumes from a saved draft with takes, waiting take and position', () => {
    let s = startRecording(newSession('script', { text: SCRIPT, makeId })).session;
    s = keepTake(rec(s, 'l1'), makeId).session;
    s = rec(s, 'l2');
    const raw = serializeDraft(s);
    const back = restoreDraft(raw, () => true)!;
    expect(back.lost).toBe(0);
    expect(back.session).toEqual(s);
    expect(takeLabel(back.session)).toBe('Take 1 of this line');
  });

  it('drops takes whose files are gone and keeps the script', () => {
    let s = startRecording(newSession('script', { text: SCRIPT, makeId })).session;
    s = keepTake(rec(s, 'l1'), makeId).session;
    s = rec(s, 'l2');
    const back = restoreDraft(serializeDraft(s), (uri) => !uri.includes('l2'))!;
    expect(back.lost).toBe(1);
    expect(back.session.pending).toBeNull();
    expect(back.session.lines[0]!.kept?.filename).toBe('l1.mp4');
    expect(back.session.lines).toHaveLength(3);
  });

  it('ignores drafts it does not understand', () => {
    expect(restoreDraft(null, () => true)).toBeNull();
    expect(restoreDraft('not json', () => true)).toBeNull();
    expect(restoreDraft(JSON.stringify({ version: 2 }), () => true)).toBeNull();
  });
});
