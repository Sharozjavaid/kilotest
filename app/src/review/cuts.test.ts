import { MODE_PRESETS, playbackRanges, toggleSegment, type Edl } from '@kilo/edl';
import { buildMockAnalysis } from '@/api/mock/build';
import { CUT_CONTEXT_SEC, cutContextSpan, cutLines, cutReasonText, cutSummary, proxyDuration, stepCut } from './cuts';
import { PlaybackController } from './playback';
import { transcriptRows } from './rows';

// s0 retake, s1 filler, s2 off script, s3 pause, s4 kept, s5 pause, s6 kept, s7 pause, s8 false start,
// s9 filler, s10 pause, s11 kept, s12 filler, s13 kept.
const analysis = buildMockAnalysis({ videoId: 'v1', clipIds: ['c1'], settings: MODE_PRESETS.general.settings });
const edl = analysis.edl;
const offsets = analysis.clipOffsets;

describe('why a line was cut, in plain words', () => {
  it('names the line a retake or false start gave way to', () => {
    expect(cutReasonText(edl, 's0')).toBe('Retake of the next line');
    expect(cutReasonText(edl, 's8')).toBe('False start, said again next');
    expect(cutReasonText(edl, 's1')).toBe('Filler words');
    expect(cutReasonText(edl, 's2')).toBe('Off script');
    expect(cutReasonText(edl, 's2', true)).toBe('Not in your script');
    expect(cutReasonText(edl, 's3')).toBe('Pause');
    expect(cutReasonText(edl, 's4')).toBeNull();
  });

  it('says so when a retake has no later take kept: the likeliest wrong cut', () => {
    // Cut every kept line after the retake: nothing replaces it any more.
    let e: Edl = edl;
    for (const id of ['s4', 's6', 's11', 's13']) e = toggleSegment(e, id);
    expect(cutReasonText(e, 's0')).toBe('Retake, but no later take is kept');
    // Only the very next line cut: a later one still stands in for it.
    expect(cutReasonText(toggleSegment(edl, 's4'), 's0')).toBe('Retake of a later line');
    expect(cutReasonText(toggleSegment(edl, 's4'), 's4')).toBe('You cut this');
  });
});

describe('the cut lines and stepping through them', () => {
  const lines = cutLines(edl);

  it('lists cut lines with words, in order, without pauses; only a retake offers keep both', () => {
    expect(lines.map((l) => l.segmentId)).toEqual(['s0', 's1', 's2', 's8', 's9', 's12']);
    expect(lines.filter((l) => l.canKeepBoth).map((l) => l.segmentId)).toEqual(['s0']);
    expect(cutSummary(lines)).toBe('6 cuts: 3 filler, 1 retake, 1 off script, 1 false start');
    expect(cutSummary([])).toBe('No cut lines');
  });

  it('steps forward and back, wrapping, and starts from the line under the playhead', () => {
    expect(stepCut(edl, lines, null, 1)!.segmentId).toBe('s0');
    expect(stepCut(edl, lines, 's0', 1)!.segmentId).toBe('s1');
    expect(stepCut(edl, lines, 's12', 1)!.segmentId).toBe('s0');
    expect(stepCut(edl, lines, 's0', -1)!.segmentId).toBe('s12');
    // Playing s6: the next cut is after it, the previous one before it.
    expect(stepCut(edl, lines, null, 1, 's6')!.segmentId).toBe('s8');
    expect(stepCut(edl, lines, null, -1, 's6')!.segmentId).toBe('s2');
    expect(stepCut(edl, [], null, 1)).toBeNull();
  });

  it('keep both restores the retake and leaves the take that replaced it', () => {
    const both = toggleSegment(edl, 's0');
    expect(both.segments.find((s) => s.id === 's0')!.keep).toBe(true);
    expect(both.segments.find((s) => s.id === 's4')!.keep).toBe(true);
    expect(cutLines(both).map((l) => l.segmentId)).not.toContain('s0');
  });

  it('plays a cut with a moment either side, clamped to the recording, then pauses', () => {
    const rows = transcriptRows(edl, offsets);
    const row = rows.find((r) => r.segmentId === 's8')!;
    const total = proxyDuration(edl, offsets);
    const span = cutContextSpan(row, total);
    expect(span.proxyStart).toBeCloseTo(row.proxyStart - CUT_CONTEXT_SEC);
    expect(span.proxyEnd).toBeCloseTo(row.proxyEnd + CUT_CONTEXT_SEC);
    expect(cutContextSpan(rows.find((r) => r.segmentId === 's0')!, total).proxyStart).toBe(0);
    expect(cutContextSpan({ proxyStart: total - 0.5, proxyEnd: total }, total).proxyEnd).toBeCloseTo(total);

    const c = new PlaybackController(playbackRanges(edl, offsets));
    let t = c.auditionSpan('s8', span);
    expect(t).toBeCloseTo(span.proxyStart);
    expect(c.snapshot().audition?.segmentId).toBe('s8');
    const visited: number[] = [];
    let last = c.tick(t);
    for (let i = 0; i < 1000 && last.type !== 'pause'; i++) {
      visited.push(t);
      if (last.type === 'seek') t = last.to;
      else t += 1 / 30;
      last = c.tick(t);
    }
    expect(last.type).toBe('pause');
    // It played straight through the recording, cut included, with no skip, and stopped after it.
    expect(Math.min(...visited)).toBeCloseTo(span.proxyStart, 1);
    expect(Math.max(...visited)).toBeLessThanOrEqual(span.proxyEnd + 0.05);
    expect(visited.some((x) => x > row.proxyStart && x < row.proxyEnd)).toBe(true);
    // Play then carries on with the edit: it paused inside the kept line after the cut, so from there.
    const resume = c.startPosition();
    const s11 = playbackRanges(edl, offsets).find((r) => r.segmentId === 's11')!;
    expect(resume).toBeGreaterThanOrEqual(s11.proxyStart - 1e-6);
    expect(resume).toBeLessThan(s11.proxyEnd);
    expect(c.snapshot().segmentId).toBe('s11');
  });
});
