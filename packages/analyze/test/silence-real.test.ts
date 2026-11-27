import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { detectSilence, readPcm16, speechTimer } from '../src/silence.js';

/**
 * Silence detection on what real recordings have and synthetic ones did not: room tone that
 * changes level within a clip, words that fade into the room, and a final stop's release.
 */

const WORK = join(import.meta.dirname, '..', '.work', 'test-silence-real');
mkdirSync(WORK, { recursive: true });
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

const SR = 16000;

/** Broadband noise at `noise` (dBFS RMS) plus a 180 Hz "voice" whose level in dB `voice(t)` gives (or null for none). */
function writeWav(name: string, sec: number, noise: (t: number) => number, voice: (t: number) => number | null): string {
  const n = Math.round(sec * SR);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  let seed = 11;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    // Uniform noise of RMS 1/sqrt(12) of its range.
    const nz = (seed / 0x7fffffff - 0.5) * Math.sqrt(12) * 10 ** (noise(t) / 20);
    const v = voice(t);
    const s = v === null ? 0 : Math.SQRT2 * 10 ** (v / 20) * Math.sin(2 * Math.PI * 180 * t);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((nz + s) * 32768))), 44 + i * 2);
  }
  const path = join(WORK, name);
  writeFileSync(path, buf);
  return path;
}

const between = (t: number, a: number, b: number) => t >= a && t < b;

describe('silence on real room tone', () => {
  it('finds a pause in room tone 12 dB louder than the room tone a few seconds away', async () => {
    // Quiet room (-72 dB) for the first 4 s, a louder take (-60 dB) after; speech at -20 dB.
    const path = writeWav('levels.wav', 9, (t) => (t < 4 ? -72 : -60), (t) =>
      between(t, 0.5, 2) || between(t, 3, 3.8) || between(t, 4.2, 5.4) || between(t, 6.4, 8) ? -20 : null);
    const gaps = await detectSilence({ clipId: 'c', audioPath: path });
    // The pause in the louder tone, 5.4-6.4, is reported (its edges may sit up to a block of the
    // local room-tone estimate, 0.15 s, inside the pause: never outside it).
    expect(gaps.some((g) => g.start >= 5.4 && g.start < 5.55 && g.end <= 6.4 && g.end > 6.25)).toBe(true);
    // No silence inside speech.
    for (const [a, b] of [[0.5, 2], [3, 3.8], [4.2, 5.4], [6.4, 8]] as const) {
      expect(gaps.every((g) => g.end <= a + 0.02 || g.start >= b - 0.02)).toBe(true);
    }
  });

  it('starts a silence where a fading word reaches the room, not where it first gets quiet', async () => {
    // A word at -20 dB that fades by 40 dB over 300 ms into -70 dB room tone.
    const path = writeWav('fade.wav', 4, () => -70, (t) => (between(t, 0.5, 1.5) ? -20 : between(t, 1.5, 1.8) ? -20 - ((t - 1.5) / 0.3) * 40 : null));
    const gaps = await detectSilence({ clipId: 'c', audioPath: path });
    const after = gaps.find((g) => g.start > 1);
    // The fade is 10 dB over the room at about 1.725 s and 4 dB over it at 1.77 s.
    expect(after!.start).toBeGreaterThan(1.72);
  });

  it('ends a word after its final stop releases ("gasped"), not at the closure before it', async () => {
    // Word, 120 ms closure at room tone, a 30 ms release burst, then a long pause.
    const path = writeWav('stop.wav', 4, () => -70, (t) => (between(t, 0.5, 1.4) ? -20 : between(t, 1.52, 1.55) ? -40 : null));
    const gaps = await detectSilence({ clipId: 'c', audioPath: path });
    expect(gaps.some((g) => g.start > 1.39 && g.start < 1.5)).toBe(false);
    expect(gaps.some((g) => g.start >= 1.54 && g.start < 1.6 && g.end > 3.9)).toBe(true);
  });

  it('measures plain speech, never room tone', () => {
    const path = writeWav('timer.wav', 4, (t) => (t < 2 ? -70 : -50), (t) => (between(t, 1, 1.5) ? -20 : null));
    const timer = speechTimer(readPcm16(readFileSync(path)));
    expect(timer(0, 4)).toBeGreaterThan(0.45);
    expect(timer(0, 4)).toBeLessThan(0.56);
    expect(timer(2, 4)).toBe(0);
  });
});
