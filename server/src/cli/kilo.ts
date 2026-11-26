import { mkdir, readFile, rm } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Edl,
  MODE_PRESETS,
  Mode,
  RenderQuality,
  edlStats,
  splitScript,
  validateEdl,
  type BrollAsset,
  type ClipInfo,
  type EditSettings,
  type IngestedClip,
  type SilenceGap,
  type Transcript,
} from '@kilo/edl';
import { loadPipeline } from '../pipeline/index.js';
import type { Pipeline } from '../pipeline/types.js';

/** A recorder-style take: script line (1-based on the command line, stored 0-based), take number, file. */
export interface TakeArg {
  lineIndex: number;
  takeNumber: number;
  file: string;
}

export interface EditArgs {
  clips: string[];
  /** Recorder-style input (`--take`): clips that are takes of script lines, several per line allowed. */
  takes: TakeArg[];
  out: string;
  mode: Mode;
  captions: boolean;
  broll: string[];
  script?: string;
  variants?: number;
  quality: RenderQuality;
  pipeline?: 'real' | 'fake';
  workDir?: string;
  keepWork: boolean;
}

export const USAGE = `usage: kilo edit <clip files...> --out <file> [--mode general|ugc_ad|tiktok_shop] [--captions]
                 [--broll <files...>] [--script <text file>] [--variants <1-5>] [--quality preview|final]
                 [--pipeline real|fake] [--work <dir>] [--keep-work]
       kilo edit --take <line>:<take>:<file> [--take ...] --script <text file> --out <file> [options]
         Recorder-style input: each --take is one take of a script line (both counted from 1),
         as the in-app recorder sends them; a line may have several takes.`;

/** Parses `<line>:<take>:<file>` (the file name may itself contain colons). */
export function parseTake(value: string): TakeArg {
  const m = /^(\d+):(\d+):(.+)$/.exec(value);
  if (!m) throw new Error(`--take needs <line>:<take>:<file>, got "${value}"`);
  const line = Number(m[1]);
  const take = Number(m[2]);
  if (line < 1 || take < 1) throw new Error(`--take line and take numbers start at 1, got "${value}"`);
  return { lineIndex: line - 1, takeNumber: take, file: m[3]! };
}

export function parseArgs(argv: string[]): EditArgs {
  const [command, ...rest] = argv;
  if (command !== 'edit') throw new Error(USAGE);
  const args: EditArgs = { clips: [], takes: [], out: '', mode: 'general', captions: false, broll: [], quality: 'final', keepWork: false };
  let list: 'clips' | 'broll' = 'clips';
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const value = () => {
      const v = rest[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value\n${USAGE}`);
      return v;
    };
    switch (a) {
      case '--out':
        args.out = value();
        break;
      case '--mode': {
        const m = Mode.safeParse(value());
        if (!m.success) throw new Error(`--mode must be one of ${Mode.options.join(', ')}`);
        args.mode = m.data;
        break;
      }
      case '--captions':
        args.captions = true;
        break;
      case '--take':
        args.takes.push(parseTake(value()));
        list = 'clips';
        break;
      case '--broll':
        list = 'broll';
        break;
      case '--script':
        args.script = value();
        break;
      case '--variants': {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 1 || n > 5) throw new Error('--variants must be 1 to 5');
        args.variants = n;
        break;
      }
      case '--quality': {
        const q = RenderQuality.safeParse(value());
        if (!q.success) throw new Error('--quality must be preview or final');
        args.quality = q.data;
        break;
      }
      case '--pipeline': {
        const p = value();
        if (p !== 'real' && p !== 'fake') throw new Error('--pipeline must be real or fake');
        args.pipeline = p;
        break;
      }
      case '--work':
        args.workDir = value();
        break;
      case '--keep-work':
        args.keepWork = true;
        break;
      default:
        if (a.startsWith('--')) throw new Error(`Unknown option ${a}\n${USAGE}`);
        args[list].push(a);
    }
  }
  if (args.takes.length && args.clips.length) throw new Error(`Give either clip files or --take, not both\n${USAGE}`);
  if (!args.clips.length && !args.takes.length) throw new Error(`Give at least one clip\n${USAGE}`);
  const seen = new Set<string>();
  for (const t of args.takes) {
    const key = `${t.lineIndex}:${t.takeNumber}`;
    if (seen.has(key)) throw new Error(`--take ${t.lineIndex + 1}:${t.takeNumber} is given twice`);
    seen.add(key);
  }
  // Takes play in script order, then take order, as the recorder uploads them.
  args.takes.sort((a, b) => a.lineIndex - b.lineIndex || a.takeNumber - b.takeNumber);
  if (!args.out) throw new Error(`--out is required\n${USAGE}`);
  return args;
}

const fmt = (sec: number) => {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
};

export interface EditResult {
  edl: Edl;
  outputs: { variantId: string | null; path: string; durationSec: number }[];
  summary: string;
}

/** The Phase 0 pipeline: ingest, transcribe, detect silence, decide, render. No database, no HTTP. */
export async function runEdit(args: EditArgs, pipeline: Pipeline, print: (line: string) => void = console.log): Promise<EditResult> {
  const work = resolve(args.workDir ?? join('.work', 'cli', `${Date.now()}`));
  await mkdir(work, { recursive: true });
  const { analyze, render, templates } = pipeline;
  try {
    const settings: EditSettings = {
      ...MODE_PRESETS[args.mode].settings,
      captions: args.captions,
      ...(args.variants !== undefined ? { hookVariations: args.variants } : {}),
    };
    const script = args.script ? splitScript(await readFile(args.script, 'utf8')) : undefined;
    const videoId = 'cli';

    const ingested: IngestedClip[] = [];
    const transcripts: Transcript[] = [];
    const silences: SilenceGap[] = [];
    const names = new Map<string, string>();
    const inputs: Array<{ file: string; take?: TakeArg }> = args.takes.length ? args.takes.map((t) => ({ file: t.file, take: t })) : args.clips.map((file) => ({ file }));
    if (script) {
      const beyond = args.takes.find((t) => t.lineIndex >= script.length);
      if (beyond) throw new Error(`--take ${beyond.lineIndex + 1}:${beyond.takeNumber}: the script has only ${script.length} lines`);
    }
    for (const [order, { file, take }] of inputs.entries()) {
      const clipId = `clip${order + 1}`;
      names.set(clipId, basename(file));
      print(`ingest   ${basename(file)}${take ? `  (line ${take.lineIndex + 1}, take ${take.takeNumber})` : ''}`);
      // One directory per clip: ingest writes fixed file names (normalized.mp4, audio.wav, thumb.jpg).
      const clip = await analyze.ingestClip({
        clipId,
        order,
        inputPath: resolve(file),
        workDir: join(work, 'ingest', clipId),
        ...(take ? { scriptLineIndex: take.lineIndex, takeNumber: take.takeNumber } : {}),
      });
      ingested.push(clip);
      transcripts.push({ ...(await analyze.transcribeClip({ clipId, audioPath: clip.audioPath, durationSec: clip.info.durationSec })), clipId });
      silences.push(...(await analyze.detectSilence({ clipId, audioPath: clip.audioPath })));
    }
    const broll: { asset: BrollAsset; path: string }[] = [];
    for (const [i, file] of args.broll.entries()) {
      print(`b-roll   ${basename(file)}`);
      const assetId = `broll${i + 1}`;
      // One directory per asset: ingest writes fixed file names (normalized.jpg, thumb.jpg).
      const result = await analyze.ingestBroll({
        assetId,
        inputPath: resolve(file),
        workDir: join(work, 'broll', assetId),
        source: 'user',
        filename: basename(file),
      });
      broll.push({ asset: result.asset, path: result.normalizedPath });
    }
    const clips: ClipInfo[] = ingested.map((c) => c.info);
    print('decide');
    const edl = Edl.parse(
      await analyze.decideEdit({
        videoId,
        clips,
        transcripts,
        silences,
        settings,
        ...(script ? { script } : {}),
        broll: broll.map((b) => b.asset),
      }),
    );
    const issues = validateEdl(edl, clips);
    if (issues.length) throw new Error(`The decider returned an invalid EDL:\n  ${issues.map((i) => i.message).join('\n  ')}`);

    const variantIds: (string | null)[] = edl.variants.length ? edl.variants.map((v) => v.id) : [null];
    const outputs: EditResult['outputs'] = [];
    const out = resolve(args.out);
    await mkdir(dirname(out), { recursive: true });
    for (const variantId of variantIds) {
      const path = variantId === null ? out : join(dirname(out), `${basename(out, extname(out))}-${variantId}${extname(out) || '.mp4'}`);
      print(`render   ${variantId ?? 'base cut'} -> ${path}`);
      const result = await render.renderVideo({
        edl,
        variantId,
        quality: args.quality,
        clips: Object.fromEntries(ingested.map((c) => [c.info.id, { path: c.normalizedPath, info: c.info }])),
        broll: Object.fromEntries(broll.map((b) => [b.asset.id, { path: b.path, asset: b.asset }])),
        transcripts,
        outPath: path,
        workDir: join(work, 'render', variantId ?? 'base'),
        renderGraphic: templates.renderGraphic,
      });
      outputs.push({ variantId, path: result.outPath, durationSec: result.durationSec });
    }

    const stats = edlStats(edl);
    const lines: string[] = [];
    lines.push('');
    lines.push(`Before: ${fmt(stats.totalSec)} across ${clips.length} clip${clips.length === 1 ? '' : 's'}`);
    for (const o of outputs) {
      const kept = edlStats(edl, o.variantId).keptSec;
      lines.push(`After:  ${fmt(kept)}${o.variantId ? ` (${o.variantId})` : ''} -> ${o.path}`);
    }
    const byReason = new Map<string, { n: number; sec: number }>();
    for (const s of edl.segments.filter((x) => !x.keep)) {
      const r = byReason.get(s.reason) ?? { n: 0, sec: 0 };
      r.n += 1;
      r.sec += s.end - s.start;
      byReason.set(s.reason, r);
    }
    lines.push(`Cut ${stats.cutCount} segment${stats.cutCount === 1 ? '' : 's'}, ${fmt(stats.totalSec - stats.keptSec)} removed:`);
    for (const [reason, r] of [...byReason].sort((a, b) => b[1].sec - a[1].sec)) {
      lines.push(`  ${reason.padEnd(11)} ${String(r.n).padStart(3)} x  ${r.sec.toFixed(1)}s`);
    }
    lines.push('Cuts:');
    for (const s of edl.segments.filter((x) => !x.keep)) {
      const text = s.text ? `  "${s.text.length > 50 ? s.text.slice(0, 47) + '...' : s.text}"` : '';
      lines.push(`  ${names.get(s.clipId) ?? s.clipId} ${fmt(s.start)}-${fmt(s.end)}  ${s.reason}${text}`);
    }
    if (edl.overlays.length) {
      lines.push(`Overlays: ${edl.overlays.map((o) => (o.type === 'broll' ? `b-roll ${o.assetId}` : `graphic ${o.template}`)).join(', ')}`);
    }
    lines.push(`Decided by: ${edl.decidedBy}`);
    const summary = lines.join('\n');
    print(summary);
    return { edl, outputs, summary };
  } finally {
    if (!args.keepWork) await rm(work, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const pipeline = await loadPipeline(args.pipeline ?? (process.env.KILO_PIPELINE === 'fake' ? 'fake' : 'real'));
    await runEdit(args, pipeline);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
