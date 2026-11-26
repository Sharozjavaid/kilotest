import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MediaStoppedError, MediaTimeoutError, isPipelineError } from '../src/errors.js';
import { FFMPEG, run } from '../src/ffmpeg.js';
import { liveChildren, mediaTimeoutMs, spawnChecked } from '../src/proc.js';

/** Finding D: no ffmpeg/ffprobe may block a worker forever or outlive its parent. */

const PKG = join(import.meta.dirname, '..');
/** Running (a zombie waiting for an init that never reaps it does not count). */
const alive = (pid: number) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !/^\d+ \(.*\) [ZX] /.test(stat);
  } catch {
    return false;
  }
};
const pgrep = (pattern: string) =>
  (spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).stdout ?? '').split('\n').filter(Boolean).map(Number).filter(alive);

describe('time limits', () => {
  it('scales with media duration, has a generous floor and an environment override', () => {
    expect(mediaTimeoutMs(undefined, {})).toBe(180_000);
    expect(mediaTimeoutMs(5, {})).toBe(180_000);
    expect(mediaTimeoutMs(600, {})).toBe(6_000_000);
    expect(mediaTimeoutMs(600, { KILO_MEDIA_TIMEOUT_FACTOR: '2' })).toBe(1_200_000);
    expect(mediaTimeoutMs(5, { KILO_MEDIA_TIMEOUT_FLOOR_SEC: '30' })).toBe(50_000);
    expect(mediaTimeoutMs(600, { KILO_MEDIA_TIMEOUT_SEC: '7' })).toBe(7_000);
    expect(mediaTimeoutMs(600, { KILO_MEDIA_TIMEOUT_SEC: 'nonsense' })).toBe(6_000_000);
  });

  it('kills a hanging child and everything it started, with a typed error', async () => {
    let pids = '';
    const t0 = Date.now();
    const err = await spawnChecked('sh', ['-c', 'sleep 1000 & echo $$ $!; wait'], {
      timeoutMs: 700,
      onStdout: (d) => (pids += d.toString()),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaTimeoutError);
    expect(isPipelineError(err)).toBe(true);
    expect((err as MediaTimeoutError).userMessage).not.toMatch(/\bsh\b|sleep|\//);
    expect(Date.now() - t0).toBeLessThan(5000);
    const [shell, grandchild] = pids.trim().split(/\s+/).map(Number);
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(shell!)).toBe(false);
    expect(alive(grandchild!)).toBe(false);
    expect(liveChildren()).toBe(0);
  });

  it('stops a real ffmpeg that would run forever', async () => {
    const err = await run(FFMPEG, ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=16x16', '-f', 'null', '-'], { timeoutMs: 1500 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaTimeoutError);
    expect(pgrep('nullsrc=s=16x16 -f null')).toEqual([]);
  });

  it('applies the environment override to ffmpeg runs', () => {
    // A fresh process, so the override is read as a worker would read it.
    const r = spawnSync(process.execPath, ['--import', 'tsx', '-e', `
      const { ffmpeg } = await import('./src/ffmpeg.ts');
      const t0 = Date.now();
      try { await ffmpeg(['-f', 'lavfi', '-i', 'nullsrc=s=16x16', '-f', 'null', '-'], 3600); console.log('finished'); }
      catch (e) { console.log(e.name, Date.now() - t0 < 5000); }
    `], { cwd: PKG, encoding: 'utf8', env: { ...process.env, KILO_MEDIA_TIMEOUT_SEC: '1' } });
    expect(r.stdout.trim()).toBe('MediaTimeoutError true');
  }, 30_000);
});

describe('stopping the parent', () => {
  const start = (marker: string, mode?: string) =>
    new Promise<{ child: ReturnType<typeof spawn>; out: () => string }>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', join('test', 'hang-parent.ts'), marker, ...(mode ? [mode] : [])], { cwd: PKG });
      let out = '';
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString();
        if (out.includes('ready')) resolve({ child, out: () => out });
      });
    });
  const exited = (child: ReturnType<typeof spawn>) =>
    new Promise<{ code: number | null; signal: string | null }>((r) => child.on('exit', (code, signal) => r({ code, signal })));

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    it(`${signal} kills every ffmpeg and grandchild, then the parent exits as it would have`, async () => {
      const marker = `kilo-hang-${signal}-${process.pid}`;
      const { child } = await start(marker);
      expect(pgrep(`title=${marker}`).length).toBe(1);
      expect(pgrep(`wait ${marker}`).length).toBe(1);
      const done = exited(child);
      child.kill(signal);
      const { signal: got } = await done;
      expect(got).toBe(signal);
      await new Promise((r) => setTimeout(r, 300));
      expect(pgrep(marker)).toEqual([]);
      expect(pgrep('sleep 99[78]')).toEqual([]);
    }, 30_000);
  }

  it('with the host handling SIGTERM itself, children die and the runs fail with a typed error', async () => {
    const marker = `kilo-hang-handled-${process.pid}`;
    const { child, out } = await start(marker, 'handled');
    const done = exited(child);
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    expect(pgrep(`title=${marker}`)).toEqual([]);
    expect(pgrep(`wait ${marker}`)).toEqual([]);
    const { code } = await done;
    expect(code).toBe(0);
    expect(out()).toContain(`ffmpeg: ${MediaStoppedError.name}`);
    expect(out()).toContain(`sh: ${MediaStoppedError.name}`);
  }, 30_000);
});
