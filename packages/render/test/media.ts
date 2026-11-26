import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { ff, WORK } from './helpers.js';

/**
 * Synthetic media made with lavfi, cached in .work/test/media. Already at the
 * IngestedClip spec (1080x1920, CFR, AAC 48 kHz stereo).
 */
const DIR = join(WORK, 'media');

function cached(name: string, make: (out: string) => void): string {
  const out = join(DIR, name);
  if (!existsSync(out)) {
    mkdirSync(DIR, { recursive: true });
    const tmp = out.replace(/(\.\w+)$/, '.part$1');
    make(tmp);
    renameSync(tmp, out);
  }
  return out;
}

export const TOGGLE_PERIOD_FRAMES = 6;
export const TOGGLE_FPS = 30;

/**
 * 12 s at 30 fps. Every 6 frames (0.2 s): 3 "kept" frames then 3 "cut" frames.
 * Kept frames are blue in even periods and green in odd ones; cut frames orange.
 * Audio: a 440 Hz tone under kept frames of even periods, silence under kept
 * frames of odd periods, a 1 kHz tone under cut frames.
 */
export function togglingClip(): string {
  return cached('toggle.mp4', (out) => {
    ff([
      '-f', 'lavfi', '-i', `color=c=0xB4441E:s=1080x1920:r=${TOGGLE_FPS}:d=12`,
      '-f', 'lavfi', '-i',
      "aevalsrc=exprs='if(lt(mod(t,0.2),0.1),if(eq(mod(floor(t/0.2),2),0),0.5*sin(2*PI*440*t),0),0.5*sin(2*PI*1000*t))':s=48000:d=12",
      '-vf',
      "drawbox=x=0:y=0:w=iw:h=ih:color=0x1F5EFF:t=fill:enable='lt(mod(n,6),3)*eq(mod(floor(n/6),2),0)'," +
        "drawbox=x=0:y=0:w=iw:h=ih:color=0x20C040:t=fill:enable='lt(mod(n,6),3)*eq(mod(floor(n/6),2),1)'",
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-g', '30', '-pix_fmt', 'yuv420p', '-threads', '2',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      out,
    ]);
  });
}

/** 3 s of solid magenta B-roll, 1080x1920 at 30 fps, no audio. */
export function magentaBroll(): string {
  return cached('magenta.mp4', (out) => {
    ff([
      '-f', 'lavfi', '-i', 'color=c=0xFF00FF:s=1080x1920:r=30:d=3',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-threads', '2', '-an', out,
    ]);
  });
}

/** A detailed still (landscape, like a phone photo) for Ken Burns. */
export function detailStill(): string {
  return cached('still.png', (out) => {
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=1600x1200:r=1', '-frames:v', '1', out]);
  });
}

export { DIR as MEDIA_DIR };
