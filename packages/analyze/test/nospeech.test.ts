import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateEdl, type DecideInput } from '@kilo/edl';
import { NO_SPEECH_MESSAGE, createAnalyze, describeProviders } from '../src/analyze.js';
import { fixtureTranscriber, isTranscriptUnavailable } from '../src/transcribe.js';
import { decideInput, synthClip } from './helpers.js';

/** Finding E: no speech-to-text must not silently turn a real video into nothing. */

const analyze = createAnalyze({ decider: 'heuristic', stock: null, log: () => {} });
const WORK = join(import.meta.dirname, '..', '.work', 'test-nospeech');

function silentInput(): DecideInput {
  // Two clips, no words: clip a has 2.4 s of silence at the start and 1.6 s at the end; b is silent throughout.
  return {
    videoId: 'v',
    clips: [
      { id: 'a', order: 0, durationSec: 10, fps: 30, width: 1080, height: 1920 },
      { id: 'b', order: 1, durationSec: 4, fps: 60, width: 1080, height: 1920 },
    ],
    transcripts: [
      { clipId: 'a', language: 'en', durationSec: 10, words: [], unavailable: true } as DecideInput['transcripts'][number],
      { clipId: 'b', language: 'en', durationSec: 4, words: [] },
    ],
    silences: [
      { clipId: 'a', start: 0, end: 2.4 },
      { clipId: 'a', start: 4.0, end: 6.5 },
      { clipId: 'a', start: 8.4, end: 10 },
      { clipId: 'b', start: 0, end: 4 },
    ],
    settings: decideInput([]).settings,
    broll: [],
  };
}

describe('no transcription service', () => {
  it('the fixture transcriber marks a clip with no sidecar as unavailable, and the mark survives JSON', async () => {
    const t = await fixtureTranscriber().transcribe({ clipId: 'x', audioPath: '/nonexistent/audio.wav', durationSec: 3 });
    expect(t.words).toEqual([]);
    expect(isTranscriptUnavailable(t)).toBe(true);
    expect(isTranscriptUnavailable(JSON.parse(JSON.stringify(t)))).toBe(true);
  });

  it('keeps the footage when no clip has any words, trimming only long silence at the ends', async () => {
    const input = silentInput();
    const { edl, notices } = await analyze.decideEditWithNotices(input);
    expect(validateEdl(edl, input.clips)).toEqual([]);
    expect(notices).toEqual([{ code: 'no_speech', message: NO_SPEECH_MESSAGE, transcriptUnavailable: true }]);
    const kept = edl.segments.filter((s) => s.keep);
    const keptA = kept.filter((s) => s.clipId === 'a');
    expect(keptA).toHaveLength(1);
    // The silence in the middle stays; the ends are trimmed with a margin, on the clip's frames.
    expect(keptA[0]!.start).toBeCloseTo(2.15, 1);
    expect(keptA[0]!.end).toBeCloseTo(8.65, 1);
    expect(keptA[0]!.start * 30).toBeCloseTo(Math.round(keptA[0]!.start * 30), 6);
    // A clip silent throughout is kept whole.
    expect(kept.filter((s) => s.clipId === 'b').map((s) => [s.start, s.end])).toEqual([[0, 4]]);
    expect(edl.segments.filter((s) => !s.keep).every((s) => s.reason === 'dead_air')).toBe(true);
    // decideEdit gives the same EDL.
    expect(await analyze.decideEdit(input)).toEqual(edl);
  });

  it('keeps everything untrimmed when dead air is not being cut', async () => {
    const input = silentInput();
    input.settings = { ...input.settings, cutDeadAir: false };
    const { edl } = await analyze.decideEditWithNotices(input);
    expect(edl.segments.every((s) => s.keep)).toBe(true);
  });

  it('says nothing when some clip has speech', async () => {
    const clips = [synthClip('c1', 0, [{ say: 'Hello there, this is a clip.' }]), synthClip('c2', 1, [{ pause: 2 }])];
    const { edl, notices } = await analyze.decideEditWithNotices(decideInput(clips));
    expect(notices).toEqual([]);
    expect(edl.segments.some((s) => !s.keep)).toBe(true);
  });

  it('a real recording with no transcript goes through ingest, transcribe and decide as kept footage', async () => {
    rmSync(WORK, { recursive: true, force: true });
    mkdirSync(WORK, { recursive: true });
    const src = join(WORK, 'talk.mp4');
    execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-threads', '2',
      '-f', 'lavfi', '-t', '6', '-i', 'testsrc2=s=360x640:r=30',
      '-f', 'lavfi', '-t', '6', '-i', "aevalsrc='0.002*(random(0)-0.5) + if(between(t,2,4), 0.3*sin(2*PI*200*t), 0)':s=48000",
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
    const a = createAnalyze({ decider: 'heuristic', transcriber: fixtureTranscriber(), stock: null, log: () => {} });
    const clip = await a.ingestClip({ clipId: 'k', order: 0, inputPath: src, workDir: join(WORK, 'k') });
    const t = await a.transcribeClip({ clipId: 'k', audioPath: clip.audioPath, durationSec: clip.info.durationSec });
    const silences = await a.detectSilence({ clipId: 'k', audioPath: clip.audioPath });
    const { edl, notices } = await a.decideEditWithNotices({ ...decideInput([]), clips: [clip.info], transcripts: [t], silences });
    expect(notices[0]?.code).toBe('no_speech');
    const kept = edl.segments.filter((s) => s.keep);
    expect(kept.reduce((n, s) => n + s.end - s.start, 0)).toBeGreaterThan(2.4);
    expect(kept[0]!.start).toBeLessThan(2);
    expect(kept[kept.length - 1]!.end).toBeGreaterThan(4);
  }, 120_000);
});

describe('describeProviders', () => {
  it('reports offline stand-ins with no keys', () => {
    const r = describeProviders({});
    expect(r.transcriber).toMatchObject({ name: 'fixture', real: false });
    expect(r.decider).toMatchObject({ name: 'heuristic', real: false });
    expect(r.standIns).toEqual(['transcriber', 'decider', 'describer', 'stock']);
    expect(r.summary).toContain('transcriber=fixture (offline stand-in)');
  });

  it('reports real services when keys are set, without printing them', () => {
    const env = { DEEPGRAM_API_KEY: 'dg-secret-123', ANTHROPIC_API_KEY: 'sk-ant-secret', PEXELS_API_KEY: 'px-secret' };
    const r = describeProviders(env);
    expect(r.transcriber).toMatchObject({ name: 'deepgram', real: true });
    expect(r.decider).toMatchObject({ name: 'claude', real: true });
    expect(r.standIns).toEqual([]);
    expect(JSON.stringify(r)).not.toMatch(/secret/);
    expect(describeProviders({ OPENAI_API_KEY: 'k' }).transcriber).toMatchObject({ name: 'openai', real: true });
  });

  it('flags a requested service that cannot run', () => {
    const r = describeProviders({ KILO_TRANSCRIBER: 'deepgram', KILO_DECIDER: 'claude' });
    expect(r.transcriber).toMatchObject({ name: 'deepgram', real: false });
    expect(r.transcriber.detail).toMatch(/DEEPGRAM_API_KEY/);
    expect(r.decider).toMatchObject({ name: 'heuristic', real: false });
    expect(r.decider.detail).toMatch(/ANTHROPIC_API_KEY/);
    expect(describeProviders({ KILO_DECIDER: 'nonsense' }).decider.real).toBe(false);
  });

  it('is also on an analyze instance, reflecting what it was given', () => {
    const r = createAnalyze({ decider: 'heuristic', transcriber: fixtureTranscriber(), stock: null, env: { ANTHROPIC_API_KEY: 'x' } }).describeProviders();
    expect(r.transcriber).toMatchObject({ name: 'fixture', real: false });
    expect(r.decider).toMatchObject({ name: 'heuristic', real: false });
  });
});
