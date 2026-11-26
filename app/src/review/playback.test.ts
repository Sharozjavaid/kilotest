import { playbackRanges, toggleSegment, type PlaybackRange } from '@kilo/edl';
import { buildMockAnalysis } from '@/api/mock/build';
import { MODE_PRESETS } from '@kilo/edl';
import { PlaybackController } from './playback';

const analysis = buildMockAnalysis({ videoId: 'v1', clipIds: ['c1'], settings: MODE_PRESETS.ugc_ad.settings });
const edl = analysis.edl;
const offsets = analysis.clipOffsets;

/** Simulates a player: advances time by dt per tick and applies the controller's commands. */
function simulate(c: PlaybackController, start: number, dt: number, maxTicks = 5000) {
  let t = start;
  const visited: number[] = [];
  const seeks: Array<{ from: number; to: number }> = [];
  for (let i = 0; i < maxTicks; i++) {
    visited.push(t);
    const cmd = c.tick(t);
    if (cmd.type === 'seek') {
      seeks.push({ from: t, to: cmd.to });
      t = cmd.to;
      continue;
    }
    if (cmd.type === 'end') return { visited, seeks, ended: true, endAt: t };
    t += dt;
  }
  return { visited, seeks, ended: false, endAt: t };
}

function inAnyRange(ranges: PlaybackRange[], t: number) {
  return ranges.some((r) => t >= r.proxyStart - 0.05 && t <= r.proxyEnd + 0.05);
}

describe('PlaybackController', () => {
  const base = playbackRanges(edl, offsets);

  it('plays only kept ranges, seeking over every cut, and ends after the last', () => {
    const c = new PlaybackController(base);
    const start = c.startPosition();
    expect(start).toBeCloseTo(base[0]!.proxyStart);
    const run = simulate(c, start, 1 / 30);
    expect(run.ended).toBe(true);
    // Every frame the player showed lies inside a kept range.
    for (const t of run.visited) expect(inAnyRange(base, t)).toBe(true);
    // One seek per gap between consecutive kept ranges.
    const gaps = base.slice(1).filter((r, i) => Math.abs(r.proxyStart - base[i]!.proxyEnd) > 0.04).length;
    expect(run.seeks).toHaveLength(gaps);
    expect(run.seeks.map((s) => s.to)).toEqual(base.slice(1).map((r) => r.proxyStart));
    expect(c.snapshot().ended).toBe(true);
    expect(c.snapshot().outTime).toBeCloseTo(c.durationSec);
  });

  it('skips the cut range 7.216..9.016 between the first two kept lines', () => {
    const c = new PlaybackController(base);
    const first = base[0]!;
    c.seekToOutput(first.outEnd - 0.1);
    c.tick(first.proxyStart + (first.outEnd - first.outStart) - 0.1); // settle the seek
    const cmd = c.tick(first.proxyEnd);
    expect(cmd).toEqual({ type: 'seek', to: base[1]!.proxyStart });
    expect(base[1]!.proxyStart).toBeGreaterThan(first.proxyEnd + 1);
  });

  it('follows a variant play order, which may jump backwards in the proxy', () => {
    const variant = edl.variants[1]!; // Hook B: s6, s4, s11, s13
    const ranges = playbackRanges(edl, offsets, variant.id);
    expect(ranges.map((r) => r.segmentId)).toEqual(['s6', 's4', 's11', 's13']);
    const c = new PlaybackController(ranges);
    const run = simulate(c, c.startPosition(), 1 / 30);
    expect(run.ended).toBe(true);
    expect(run.seeks[0]!.to).toBeCloseTo(ranges[1]!.proxyStart);
    expect(run.seeks[0]!.to).toBeLessThan(run.seeks[0]!.from);
  });

  it('ignores stale ticks right after a seek until the player lands', () => {
    const c = new PlaybackController(base);
    c.startPosition();
    const to = c.seekToOutput(base[1]!.outStart + 0.5);
    // The player still reports the old time for a couple of frames.
    expect(c.tick(0)).toEqual({ type: 'none' });
    expect(c.tick(0.01)).toEqual({ type: 'none' });
    expect(c.tick(to)).toEqual({ type: 'none' });
    expect(c.snapshot().segmentId).toBe(base[1]!.segmentId);
    expect(c.snapshot().outTime).toBeCloseTo(base[1]!.outStart + 0.5);
  });

  it('auditions a cut segment, then carries on with the next kept range', () => {
    const c = new PlaybackController(base);
    const cut = edl.segments.find((s) => s.id === 's5')!; // dead air between s4 and s6
    const span = { proxyStart: offsets.c1! + cut.start, proxyEnd: offsets.c1! + cut.end };
    const at = c.seekToSegment('s5', span);
    expect(at).toBeCloseTo(span.proxyStart);
    expect(c.snapshot().audition?.segmentId).toBe('s5');
    expect(c.tick(span.proxyStart)).toEqual({ type: 'none' }); // the seek lands
    expect(c.tick(span.proxyStart + 0.5)).toEqual({ type: 'none' });
    // Reaching the end of the cut lands exactly on s6, which starts there: no seek needed.
    const cmd = c.tick(span.proxyEnd);
    expect(cmd.type === 'none' || (cmd.type === 'seek' && Math.abs(cmd.to - span.proxyEnd) < 0.05)).toBe(true);
    expect(c.snapshot().audition).toBeNull();
    expect(c.snapshot().segmentId).toBe('s6');
  });

  it('keeps its place when the ranges change under it (a toggle)', () => {
    const c = new PlaybackController(base);
    c.seekToOutput(base[2]!.outStart + 0.3);
    c.tick(base[2]!.proxyStart + 0.3);
    const restored = toggleSegment(edl, 's5');
    c.setRanges(playbackRanges(restored, offsets));
    expect(c.snapshot().segmentId).toBe(base[2]!.segmentId);
  });

  it('restarts from the first range after ending', () => {
    const c = new PlaybackController(base);
    simulate(c, c.startPosition(), 0.1);
    expect(c.snapshot().ended).toBe(true);
    expect(c.startPosition()).toBeCloseTo(base[0]!.proxyStart);
    expect(c.snapshot().ended).toBe(false);
  });

  it('maps output time to proxy time through the ranges', () => {
    const c = new PlaybackController(base);
    const r = base[2]!;
    expect(c.seekToOutput(r.outStart + 1)).toBeCloseTo(r.proxyStart + 1);
    expect(c.seekToOutput(9999)).toBeLessThanOrEqual(base[base.length - 1]!.proxyEnd);
  });
});
