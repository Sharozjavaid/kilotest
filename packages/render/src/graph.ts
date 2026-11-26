import type { KenBurns, Transition } from '@kilo/edl';
import { num, THREADS } from './ffmpeg.js';
import { CUT_FADE_SEC, OVERLAY_FADE_FRAMES, type Chunk, type OutputFormat, type OverlayPiece, type PlanItem } from './plan.js';

/**
 * Builders for the ffmpeg argument arrays. Each chunk is one ffmpeg invocation:
 * every segment is its own input, seeked with `-ss` a little early and trimmed
 * precisely in the graph, so no input is decoded twice and nothing is buffered.
 */

/** Seek this far before the wanted frame and trim the rest in the graph. */
const PREROLL = 0.5;
/** Where a punch-in zoom is anchored, as a fraction of the height: faces sit high in a selfie frame. */
export const ZOOM_ANCHOR_Y = 0.4;
export const AUDIO_RATE = 48000;

const XFADE: Record<Exclude<Transition, 'cut'>, string> = {
  crossfade: 'fade',
  dip_to_white: 'fadewhite',
  slide_up: 'slideup',
};

class Inputs {
  args: string[] = [];
  count = 0;
  add(args: string[]): number {
    this.args.push(...args);
    return this.count++;
  }
}

function seekArgs(srcTime: number, lengthSec: number): { args: string[]; rel: number } {
  const at = Math.max(0, srcTime - PREROLL);
  const rel = srcTime - at;
  const args = at > 0 ? ['-ss', num(at)] : [];
  args.push('-t', num(rel + lengthSec + 0.5));
  return { args, rel };
}

/** Cover-scale to exactly w x h (centre crop). */
export function cover(w: number, h: number): string {
  return `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h},setsar=1`;
}

/** Punch-in on the source frame, anchored slightly above the middle. */
export function zoomCrop(zoom: number): string {
  if (zoom <= 1.0001) return '';
  const z = num(zoom);
  return `crop=w='2*trunc(iw/${z}/2)':h='2*trunc(ih/${z}/2)':x='(iw-ow)/2':y='${num(ZOOM_ANCHOR_Y)}*(ih-oh)',`;
}

function framesTail(frames: number, F: number): string {
  return `tpad=stop_mode=clone:stop=${frames},trim=end_frame=${frames},setpts=N/(${F}*TB)`;
}

/** Ken Burns as sub-pixel corner coordinates for `perspective` (sense=source), so slow pans do not stair-step. */
export function kenBurnsFilter(kb: KenBurns, offsetFrames: number, totalFrames: number): string {
  const d = Math.max(1, totalFrames - 1);
  const e = `(0.5-0.5*cos(PI*clip((in+${offsetFrames})/${d},0,1)))`;
  const lerp = (a: number, b: number) => (a === b ? num(a) : `(${num(a)}+${num(b - a)}*${e})`);
  const s = lerp(kb.fromScale, kb.toScale);
  const x = lerp(kb.fromX, kb.toX);
  const y = lerp(kb.fromY, kb.toY);
  const ww = `(W/${s})`;
  const hh = `(H/${s})`;
  const cx = `(W/2+${x}*(W-${ww})/2)`;
  const cy = `(H/2+${y}*(H-${hh})/2)`;
  const left = `${cx}-${ww}/2`;
  const right = `${cx}+${ww}/2`;
  const top = `${cy}-${hh}/2`;
  const bottom = `${cy}+${hh}/2`;
  return (
    `perspective=x0='${left}':y0='${top}':x1='${right}':y1='${top}':` +
    `x2='${left}':y2='${bottom}':x3='${right}':y3='${bottom}':interpolation=linear:sense=source:eval=frame`
  );
}

/** Internal scale for Ken Burns: render bigger than the frame so magnified stills keep detail. */
function kbInternal(kb: KenBurns, fmt: OutputFormat): { w: number; h: number } {
  const k = Math.min(1.5, Math.max(1, kb.fromScale, kb.toScale));
  const even = (n: number) => 2 * Math.round(n / 2);
  return { w: even(fmt.width * k), h: even(fmt.height * k) };
}

export interface VideoChunkOptions {
  fmt: OutputFormat;
  chunk: Chunk;
  /** ASS file name relative to the ffmpeg working directory. */
  assFile?: string;
  encoder: string[];
  outFile: string;
}

export function videoChunkArgs(o: VideoChunkOptions): string[] {
  const { fmt, chunk } = o;
  const F = fmt.fps;
  const W = fmt.width;
  const H = fmt.height;
  const inputs = new Inputs();
  const graph: string[] = [];

  const segLabels: string[] = [];
  for (const it of chunk.items) {
    const label = segmentChain(it, fmt, inputs, graph);
    segLabels.push(label);
  }
  let cur = 'base';
  if (segLabels.length === 1) graph.push(`[${segLabels[0]}]null[base]`);
  else graph.push(`${segLabels.map((l) => `[${l}]`).join('')}concat=n=${segLabels.length}:v=1:a=0[base]`);

  // B-roll under graphics; each kind in time order.
  const pieces = [...chunk.pieces].sort(
    (a, b) => (a.overlay.kind === b.overlay.kind ? a.localStart - b.localStart : a.overlay.kind === 'broll' ? -1 : 1),
  );
  pieces.forEach((p, n) => {
    const ov = overlayChain(p, fmt, inputs, graph, n);
    const next = `ov${n}`;
    graph.push(`[${cur}][${ov}]overlay=x=0:y=0:eof_action=pass:repeatlast=0:format=yuv420[${next}]`);
    cur = next;
  });
  if (o.assFile) {
    graph.push(`[${cur}]ass=filename=${o.assFile}[cap]`);
    cur = 'cap';
  }
  graph.push(`[${cur}]format=yuv420p,setsar=1[vout]`);
  return [
    ...inputs.args,
    '-filter_complex_threads',
    String(THREADS),
    '-filter_complex',
    graph.join(';\n'),
    '-map',
    '[vout]',
    '-frames:v',
    String(chunk.frames),
    ...o.encoder,
    '-an',
    o.outFile,
  ];
}

function segmentChain(it: PlanItem, fmt: OutputFormat, inputs: Inputs, graph: string[]): string {
  const F = fmt.fps;
  const cf = it.clipFps;
  const srcDur = (it.srcEndFrame - it.srcStartFrame) / cf;
  const { args, rel } = seekArgs(it.srcStart, Math.max(srcDur, it.frames / F));
  const k = inputs.add(['-threads', '1', ...args, '-an', '-i', it.clipPath]);
  const half = 0.5 / cf;
  const trim = `trim=start=${num(Math.max(0, rel - half))}:end=${num(rel + srcDur - half)}`;
  const label = `s${it.index}`;
  const picture = `${zoomCrop(it.zoom)}${cover(fmt.width, fmt.height)},fps=${F},format=yuv420p`;
  if (!it.held || it.transition === 'cut') {
    graph.push(`[${k}:v]${trim},setpts=PTS-STARTPTS,${picture},${framesTail(it.frames, F)}[${label}]`);
    return label;
  }
  // Transition: the incoming picture comes in over a held last frame of the outgoing one.
  const T = it.transitionFrames;
  const held = it.held;
  const hs = seekArgs(held.srcTime, 1 / held.clipFps);
  const hk = inputs.add(['-threads', '1', ...hs.args, '-an', '-i', held.clipPath]);
  const hhalf = 0.5 / held.clipFps;
  graph.push(
    `[${hk}:v]trim=start=${num(Math.max(0, hs.rel - hhalf))},setpts=PTS-STARTPTS,trim=end_frame=1,` +
      `${zoomCrop(held.zoom)}${cover(fmt.width, fmt.height)},format=yuv420p,fps=${F},${framesTail(T, F)}[h${it.index}]`,
  );
  graph.push(`[${k}:v]${trim},setpts=PTS-STARTPTS,${picture},${framesTail(it.frames, F)}[i${it.index}]`);
  const xf = XFADE[it.transition as Exclude<Transition, 'cut'>];
  graph.push(
    `[h${it.index}][i${it.index}]xfade=transition=${xf}:duration=${num(T / F)}:offset=0,${framesTail(it.frames, F)}[${label}]`,
  );
  return label;
}

function overlayChain(p: OverlayPiece, fmt: OutputFormat, inputs: Inputs, graph: string[], n: number): string {
  const F = fmt.fps;
  const W = fmt.width;
  const H = fmt.height;
  const ov = p.overlay;
  const label = `o${n}`;
  const shift = `setpts=PTS+${num(p.localStart / F)}/TB`;
  const fades: string[] = [];
  const fd = num(OVERLAY_FADE_FRAMES / F);
  if (p.fadeIn) fades.push(`fade=t=in:st=0:d=${fd}:alpha=1`);
  if (p.fadeOut) fades.push(`fade=t=out:st=${num((p.frames - OVERLAY_FADE_FRAMES) / F)}:d=${fd}:alpha=1`);
  const fadeStr = fades.length ? `,${fades.join(',')}` : '';

  if (ov.kind === 'graphic') {
    if (!ov.path) throw new Error(`Graphic overlay ${ov.overlay.id} was not rendered`);
    const at = p.offsetFrames / F;
    const args = at > 0 ? ['-ss', num(at)] : [];
    const k = inputs.add(['-threads', '1', ...args, '-t', num(p.frames / F + 0.5), '-i', ov.path]);
    // Templates animate their own entrance and exit; only a graphic cut short gets a fade to hide the cut.
    const cutShort = p.fadeOut && (ov.renderedFrames ?? ov.frames) > ov.frames;
    const out = cutShort ? `,fade=t=out:st=${num((p.frames - OVERLAY_FADE_FRAMES) / F)}:d=${fd}:alpha=1` : '';
    graph.push(
      `[${k}:v]setpts=PTS-STARTPTS,fps=${F},scale=${W}:${H}:flags=bicubic,format=yuva444p,${framesTail(p.frames, F)}${out},${shift}[${label}]`,
    );
    return label;
  }

  const kb = ov.overlay.kenBurns;
  const totalFrames = ov.frames;
  let picture: string;
  if (kb) {
    const big = kbInternal(kb, fmt);
    picture = `${cover(big.w, big.h)},format=yuv420p,PLACEHOLDER,${kenBurnsFilter(kb, p.offsetFrames, totalFrames)}`;
    if (big.w !== W) picture += `,scale=${W}:${H}:flags=bicubic`;
  } else {
    picture = `${cover(W, H)},PLACEHOLDER`;
  }
  if (ov.asset.kind === 'image') {
    // Scale the still once, then repeat that frame.
    const k = inputs.add(['-i', ov.path]);
    const rep = `loop=loop=${p.frames - 1}:size=1:start=0,setpts=N/(${F}*TB),fps=${F}`;
    graph.push(`[${k}:v]${picture.replace('PLACEHOLDER', rep)},format=yuva420p,${framesTail(p.frames, F)}${fadeStr},${shift}[${label}]`);
  } else {
    const dur = ov.asset.durationSec;
    let at = ov.overlay.sourceStartSec + p.offsetFrames / F;
    if (dur !== undefined) at = Math.max(0, Math.min(at, dur - 0.1));
    const args = at > 0 ? ['-ss', num(at)] : [];
    const k = inputs.add(['-threads', '1', ...args, '-t', num(p.frames / F + 0.5), '-an', '-i', ov.path]);
    graph.push(
      `[${k}:v]setpts=PTS-STARTPTS,fps=${F},${picture.replace('PLACEHOLDER', 'null')},format=yuva420p,${framesTail(p.frames, F)}${fadeStr},${shift}[${label}]`,
    );
  }
  return label;
}

export function sampleBounds(frameStart: number, frames: number, F: number): { start: number; count: number } {
  const start = Math.round((frameStart * AUDIO_RATE) / F);
  const end = Math.round(((frameStart + frames) * AUDIO_RATE) / F);
  return { start, count: end - start };
}

export interface AudioChunkOptions {
  fmt: OutputFormat;
  chunk: Chunk;
  /** Clip ids that have no audio stream: they get silence. */
  silentClips: Set<string>;
  outFile: string;
}

/** The speaker's audio for a chunk, sample-exact to the picture, with a short fade either side of each cut. */
export function audioChunkArgs(o: AudioChunkOptions): string[] {
  const F = o.fmt.fps;
  const inputs = new Inputs();
  const graph: string[] = [];
  const labels: string[] = [];
  const fadeSamples = Math.round(CUT_FADE_SEC * AUDIO_RATE);
  for (const it of o.chunk.items) {
    const { count } = sampleBounds(it.frameStart, it.frames, F);
    const fades: string[] = [];
    const nf = Math.min(fadeSamples, Math.floor(count / 2));
    if (it.fadeIn && nf > 0) fades.push(`afade=t=in:start_sample=0:nb_samples=${nf}`);
    if (it.fadeOut && nf > 0) fades.push(`afade=t=out:start_sample=${count - nf}:nb_samples=${nf}`);
    const fadeStr = fades.length ? `,${fades.join(',')}` : '';
    const label = `a${it.index}`;
    const fmtStr = `aformat=sample_fmts=fltp:sample_rates=${AUDIO_RATE}:channel_layouts=stereo`;
    if (o.silentClips.has(it.clipId)) {
      graph.push(`anullsrc=r=${AUDIO_RATE}:cl=stereo,atrim=end_sample=${count},${fmtStr}[${label}]`);
    } else {
      const { args, rel } = seekArgs(it.srcStart, count / AUDIO_RATE);
      const k = inputs.add(['-threads', '1', ...args, '-vn', '-i', it.clipPath]);
      graph.push(
        `[${k}:a]aresample=${AUDIO_RATE},${fmtStr},atrim=start=${num(rel)},asetpts=PTS-STARTPTS,` +
          `apad=whole_len=${count},atrim=end_sample=${count}${fadeStr}[${label}]`,
      );
    }
    labels.push(label);
  }
  if (labels.length === 1) graph.push(`[${labels[0]}]anull[aout]`);
  else graph.push(`${labels.map((l) => `[${l}]`).join('')}concat=n=${labels.length}:v=0:a=1[aout]`);
  return [
    ...inputs.args,
    '-filter_complex',
    graph.join(';\n'),
    '-map',
    '[aout]',
    '-c:a',
    'pcm_f32le',
    '-ar',
    String(AUDIO_RATE),
    '-ac',
    '2',
    o.outFile,
  ];
}

export function encoderArgs(fmt: OutputFormat): string[] {
  const preset = process.env.KILO_RENDER_PRESET ?? 'veryfast';
  const common = ['-c:v', 'libx264', '-preset', preset, '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-threads', String(THREADS)];
  const gop = ['-g', String(Math.round(fmt.fps * 2)), '-keyint_min', String(Math.round(fmt.fps / 2))];
  if (fmt.quality === 'final') {
    return [...common, '-level:v', '4.2', '-b:v', '12M', '-maxrate', '15M', '-bufsize', '24M', ...gop];
  }
  return [...common, '-b:v', '2500k', '-maxrate', '3500k', '-bufsize', '5M', ...gop];
}
