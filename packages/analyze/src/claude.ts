import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';
import type { BrollAsset, EditSettings, TemplateId } from '@kilo/edl';
import { MODE_PRESETS, PACING_PARAMS, TEMPLATES, getTemplate, parseTemplateProps } from '@kilo/edl';
import type { Chunk } from './chunks.js';
import { THREADS, ffmpeg, fileInput } from './ffmpeg.js';
import type { ChunkDecision, CutDecisions } from './heuristic.js';
import type { BrollDescriber } from './ingest.js';

/** Default model, per CONTRACTS.md section 4. */
export const DEFAULT_CLAUDE_MODEL = 'claude-fable-5-2';

/**
 * The slice of the Anthropic client this package calls. The real client satisfies it;
 * tests inject a fake. Claude is only ever reached through `beta.messages.parse`
 * with a structured output format.
 */
export interface ClaudeLike {
  beta: {
    messages: {
      parse(
        params: any, // eslint-disable-line @typescript-eslint/no-explicit-any
        options?: { timeout?: number },
      ): PromiseLike<{ stop_reason: string | null; parsed_output: unknown }>;
    };
  };
}

export function createClaudeClient(env: NodeJS.ProcessEnv = process.env): ClaudeLike | null {
  if (!env.ANTHROPIC_API_KEY) return null;
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2 }) as unknown as ClaudeLike;
}

/** Server-side refusal fallback on the models that support it. */
function fallbackParams(model: string): Record<string, unknown> {
  return /fable|mythos|opus-5|sonnet-5-5/.test(model)
    ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }
    : {};
}

// ---- edit decisions --------------------------------------------------------

const TEMPLATE_IDS = TEMPLATES.map((t) => t.id) as [TemplateId, ...TemplateId[]];

export const ClaudeEditSchema = z.object({
  decisions: z.array(
    z.object({
      utterance: z.number().int(),
      keep: z.boolean(),
      reason: z.enum(['speech', 'false_start', 'retake', 'filler', 'off_script']),
      why: z.string(),
    }),
  ),
  broll: z.array(z.object({ utterance: z.number().int(), assetId: z.string(), why: z.string() })),
  graphics: z.array(
    z.object({
      utterance: z.number().int(),
      template: z.enum(TEMPLATE_IDS),
      text: z.string().nullable(),
      title: z.string().nullable(),
      items: z.array(z.string()),
      value: z.string().nullable(),
      label: z.string().nullable(),
      price: z.string().nullable(),
      compareAt: z.string().nullable(),
      words: z.array(z.string()),
    }),
  ),
  hooks: z.array(
    z.object({
      kind: z.enum(['natural', 'cold_open', 'title']),
      utterance: z.number().int().nullable(),
      titleText: z.string().nullable(),
      hookText: z.string(),
    }),
  ),
});
export type ClaudeEdit = z.infer<typeof ClaudeEditSchema>;

export interface ClaudePlan {
  decisions: CutDecisions;
  broll: Array<{ chunkId: number; assetId: string }>;
  graphics: Array<{ chunkId: number; template: TemplateId; props: Record<string, unknown> }>;
  hooks: Array<{ kind: 'natural' } | { kind: 'cold_open'; chunkId: number } | { kind: 'title'; text: string }>;
}

function describeChunk(c: Chunk, prev: Chunk | undefined, clipNumber: number, hint: ChunkDecision | undefined): string {
  const pause = prev && prev.clipId === c.clipId ? c.start - prev.end : null;
  const words = c.words.map((w) => (w.filler ? `{${w.text}}` : w.text)).join(' ');
  const where = [
    `clip ${clipNumber}`,
    c.scriptLineIndex !== undefined ? `script line ${c.scriptLineIndex + 1}` : '',
    c.takeNumber !== undefined ? `take ${c.takeNumber}` : '',
    `${c.start.toFixed(2)}s`,
    pause !== null ? `after ${pause.toFixed(2)}s pause` : 'clip start',
    c.complete ? 'finished sentence' : 'unfinished',
  ]
    .filter(Boolean)
    .join(', ');
  const guess = hint ? `; automatic guess: ${hint.keep ? 'keep' : `cut (${hint.reason})`}` : '';
  return `[${c.id}] (${where}${guess}) ${words}`;
}

export function buildEditPrompt(input: {
  chunks: Chunk[];
  clipOrder: string[];
  settings: EditSettings;
  script?: string[];
  broll: BrollAsset[];
  hints?: CutDecisions;
  /** Cuts are final; only placement is wanted. */
  replan?: boolean;
}): { system: string; user: string } {
  const { settings } = input;
  const preset = MODE_PRESETS[settings.mode];
  const pacing = PACING_PARAMS[settings.pacing];
  const system = [
    'You are the editor inside Kilo, an app that turns a creator\'s raw talking clips into a tight vertical short-form video.',
    'You edit the transcript, not the video. You see numbered utterances and decide, for each one, whether it stays in the video.',
    'You never choose timestamps: code snaps every cut to silence and word boundaries afterwards.',
    'Rules for cutting:',
    '- When the speaker says a line more than once, keep only the last complete take and cut the earlier or abandoned ones (reason "retake" for a complete earlier take, "false_start" for an abandoned one).',
    '- Cut talk that is not part of the video: asides to the camera person, "hold on", "wait", "was that okay", "let me start again" (reason "off_script").',
    '- An utterance that is only filler words is reason "filler". Filler words inside a kept utterance are marked {like this}; code removes them when the creator asked for that, so keep the utterance.',
    '- A kept utterance always has reason "speech". Every utterance gets exactly one decision.',
    '- When a script is given, keep the last complete take of each script line and cut speech that matches no line.',
    '- Never cut a sentence that is the only take of what it says unless it is off-script chatter.',
  ].join('\n');
  const lines: string[] = [];
  lines.push(`Mode: ${preset.label}. ${preset.guidance}`);
  lines.push(
    `Creator settings: remove retakes ${settings.removeRetakes ? 'on' : 'off'}, remove fillers ${settings.removeFillers ? 'on' : 'off'}, ` +
      `cut dead air ${settings.cutDeadAir ? 'on' : 'off'}, pacing ${settings.pacing} (pauses over ${pacing.maxSilenceSec}s are shortened by code), ` +
      `B-roll ${settings.broll ? 'on' : 'off'}, graphics ${settings.graphics ? 'on' : 'off'}, hook variations ${settings.hookVariations}.`,
  );
  if (input.replan) {
    lines.push('This is a re-plan of placements only. The cuts are final: every utterance below is in the video. Mark each one keep: true with reason "speech" and plan B-roll, graphics and hooks.');
  }
  if (!settings.removeRetakes) lines.push('Retake removal is off: keep every utterance that is speech, even repeated takes.');
  if (input.script?.length) {
    lines.push('', 'Script (teleprompter lines):');
    input.script.forEach((l, i) => lines.push(`  line ${i + 1}: ${l}`));
  }
  lines.push('', 'Utterances in natural order:');
  const clipNumber = new Map(input.clipOrder.map((id, i) => [id, i + 1]));
  input.chunks.forEach((c, i) => lines.push(describeChunk(c, input.chunks[i - 1], clipNumber.get(c.clipId) ?? 0, input.hints?.get(c.id))));

  if (settings.broll && input.broll.length) {
    lines.push('', 'B-roll the creator added for this video (place each on a kept utterance whose words it illustrates; the first ~2 seconds stay on the speaker; use each asset at most once; leave out assets that fit nothing):');
    for (const a of input.broll) lines.push(`  ${a.id}: ${a.kind}${a.durationSec ? `, ${a.durationSec.toFixed(1)}s` : ''} - ${a.description}`);
  } else lines.push('', 'B-roll: none. Return an empty broll list.');

  if (settings.graphics) {
    lines.push('', 'Motion graphic templates (pick sparingly, about one overlay per 5-6 seconds at most, on kept utterances; fill only the fields the template uses and set the others to null or []):');
    for (const t of TEMPLATES) {
      lines.push(`  ${t.id} (${t.placement}, ${t.minDurationSec}-${t.maxDurationSec}s): ${t.description} Example props: ${JSON.stringify(t.example)}`);
    }
    lines.push(
      '  Field limits: bold-title text <= 60 chars; numbered-list title <= 40, 2-5 items <= 40 chars each; stat-callout value <= 10, label <= 50;',
      '  keyword-pop 1-4 words <= 18 chars each; price-tag price <= 12, compareAt <= 12, label <= 40. At most one bold-title.',
      '  Use numbered-list when the speaker lists things, stat-callout for a spoken figure, price-tag for a spoken price (mainly TikTok Shop and UGC ads), keyword-pop for emphasised words.',
    );
  } else lines.push('', 'Graphics: off. Return an empty graphics list.');

  if (settings.hookVariations > 1) {
    lines.push(
      '',
      `Hooks: return exactly ${settings.hookVariations} hooks. The first is {"kind":"natural"} (the video as cut). ` +
        'Each other hook opens differently: "cold_open" moves one strong later kept utterance to the very front (give its number), ' +
        'or "title" keeps the order and shows a bold title over the opening (give titleText, <= 60 chars). ' +
        'hookText is the opening line the viewer hears or reads. Make them distinct.',
    );
  } else lines.push('', 'Hooks: return an empty hooks list.');
  return { system, user: lines.join('\n') };
}

function trimOrNull(s: string | null | undefined): string | undefined {
  const t = (s ?? '').trim();
  return t ? t : undefined;
}

export function propsFromClaude(g: ClaudeEdit['graphics'][number]): Record<string, unknown> {
  switch (g.template) {
    case 'bold-title':
      return { text: trimOrNull(g.text) ?? '' };
    case 'numbered-list': {
      const title = trimOrNull(g.title);
      return { ...(title ? { title } : {}), items: g.items.map((i) => i.trim()).filter(Boolean) };
    }
    case 'stat-callout':
      return { value: trimOrNull(g.value) ?? '', label: trimOrNull(g.label) ?? '' };
    case 'keyword-pop':
      return { words: g.words.map((w) => w.trim()).filter(Boolean) };
    case 'price-tag': {
      const compareAt = trimOrNull(g.compareAt);
      const label = trimOrNull(g.label);
      return { price: trimOrNull(g.price) ?? '', ...(compareAt ? { compareAt } : {}), ...(label ? { label } : {}) };
    }
  }
}

export class InvalidClaudeOutput extends Error {}

/** Checks Claude's answer against the utterances, the assets, the catalog and the settings. */
export function validateClaudeEdit(edit: ClaudeEdit, input: { chunks: Chunk[]; settings: EditSettings; broll: BrollAsset[] }): ClaudePlan {
  const ids = new Set(input.chunks.map((c) => c.id));
  const decisions: CutDecisions = new Map();
  for (const d of edit.decisions) {
    if (!ids.has(d.utterance)) throw new InvalidClaudeOutput(`Unknown utterance ${d.utterance}`);
    if (decisions.has(d.utterance)) throw new InvalidClaudeOutput(`Utterance ${d.utterance} decided twice`);
    if (d.keep !== (d.reason === 'speech')) throw new InvalidClaudeOutput(`Utterance ${d.utterance}: keep and reason disagree`);
    decisions.set(d.utterance, { keep: d.keep, reason: d.reason, note: d.why });
  }
  for (const id of ids) if (!decisions.has(id)) throw new InvalidClaudeOutput(`Utterance ${id} has no decision`);
  if (input.chunks.length && ![...decisions.values()].some((d) => d.keep)) throw new InvalidClaudeOutput('Nothing kept');

  const kept = (u: number) => decisions.get(u)?.keep === true;
  const assets = new Set(input.broll.map((a) => a.id));
  const broll: ClaudePlan['broll'] = [];
  if (input.settings.broll) {
    for (const b of edit.broll) {
      if (!assets.has(b.assetId)) throw new InvalidClaudeOutput(`Unknown B-roll asset ${b.assetId}`);
      if (!kept(b.utterance)) throw new InvalidClaudeOutput(`B-roll on cut utterance ${b.utterance}`);
      broll.push({ chunkId: b.utterance, assetId: b.assetId });
    }
  }
  const graphics: ClaudePlan['graphics'] = [];
  if (input.settings.graphics) {
    let titles = 0;
    for (const g of edit.graphics) {
      if (!kept(g.utterance)) throw new InvalidClaudeOutput(`Graphic on cut utterance ${g.utterance}`);
      const props = propsFromClaude(g);
      try {
        parseTemplateProps(g.template, props);
      } catch (err) {
        throw new InvalidClaudeOutput(`Bad props for ${g.template}: ${(err as Error).message}`);
      }
      if (g.template === 'bold-title' && ++titles > 1) throw new InvalidClaudeOutput('More than one bold-title');
      getTemplate(g.template);
      graphics.push({ chunkId: g.utterance, template: g.template, props });
    }
  }
  const hooks: ClaudePlan['hooks'] = [];
  const n = input.settings.hookVariations;
  if (n > 1) {
    if (edit.hooks.length !== n) throw new InvalidClaudeOutput(`Expected ${n} hooks, got ${edit.hooks.length}`);
    const firstKept = input.chunks.find((c) => kept(c.id))?.id;
    edit.hooks.forEach((h, i) => {
      if (i === 0 || h.kind === 'natural') {
        if (i !== 0) throw new InvalidClaudeOutput('Only the first hook may be natural');
        hooks.push({ kind: 'natural' });
      } else if (h.kind === 'cold_open') {
        if (h.utterance === null || !kept(h.utterance) || h.utterance === firstKept) {
          throw new InvalidClaudeOutput(`Cold open needs a later kept utterance, got ${h.utterance}`);
        }
        hooks.push({ kind: 'cold_open', chunkId: h.utterance });
      } else {
        const text = trimOrNull(h.titleText);
        try {
          parseTemplateProps('bold-title', { text });
        } catch {
          throw new InvalidClaudeOutput('Title hook needs titleText of 1-60 chars');
        }
        hooks.push({ kind: 'title', text: text! });
      }
    });
  }
  return { decisions, broll, graphics, hooks };
}

export interface ClaudeDeciderOptions {
  client: ClaudeLike;
  model?: string;
  timeoutMs?: number;
}

/** Asks Claude for the edit. Throws on refusal, truncation, or output that fails validation. */
export async function claudeEdit(
  opts: ClaudeDeciderOptions,
  input: { chunks: Chunk[]; clipOrder: string[]; settings: EditSettings; script?: string[]; broll: BrollAsset[]; hints?: CutDecisions; replan?: boolean },
): Promise<ClaudePlan> {
  const model = opts.model ?? DEFAULT_CLAUDE_MODEL;
  const { system, user } = buildEditPrompt(input);
  const res = await opts.client.beta.messages.parse(
    {
      model,
      max_tokens: 16000,
      ...fallbackParams(model),
      output_config: { effort: 'high', format: betaZodOutputFormat(ClaudeEditSchema) },
      system,
      messages: [{ role: 'user', content: user }],
    },
    { timeout: opts.timeoutMs ?? 300_000 },
  );
  if (res.stop_reason === 'refusal') throw new InvalidClaudeOutput('Claude declined the request');
  if (res.stop_reason === 'max_tokens') throw new InvalidClaudeOutput('Claude ran out of output tokens');
  const parsed = ClaudeEditSchema.safeParse(res.parsed_output);
  if (!parsed.success) throw new InvalidClaudeOutput(`Unparseable output: ${parsed.error.message.slice(0, 200)}`);
  return validateClaudeEdit(parsed.data, input);
}

// ---- B-roll description ----------------------------------------------------

const DescriptionSchema = z.object({ description: z.string() });

/** Claude vision on a few sampled frames; one line of what is visible. */
export function claudeDescriber(opts: ClaudeDeciderOptions, fallback: BrollDescriber): BrollDescriber {
  return async (input) => {
    try {
      const frames: string[] = [];
      if (input.kind === 'image') {
        const out = join(input.workDir, 'describe-0.jpg');
        await ffmpeg(['-threads', THREADS, ...(await fileInput(input.normalizedPath)), '-frames:v', '1', '-vf', "scale='min(768,iw)':-2", '-q:v', '4', out]);
        frames.push(out);
      } else {
        const d = input.durationSec ?? 1;
        for (const [k, f] of [0.15, 0.5, 0.85].entries()) {
          const out = join(input.workDir, `describe-${k}.jpg`);
          await ffmpeg(['-threads', THREADS, '-ss', (d * f).toFixed(3), ...(await fileInput(input.normalizedPath)), '-frames:v', '1', '-vf', 'scale=432:-2', '-q:v', '4', out]);
          frames.push(out);
        }
      }
      const images = await Promise.all(
        frames.map(async (f) => ({
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: (await readFile(f)).toString('base64') },
        })),
      );
      const model = opts.model ?? DEFAULT_CLAUDE_MODEL;
      const res = await opts.client.beta.messages.parse(
        {
          model,
          max_tokens: 2000,
          ...fallbackParams(model),
          output_config: { effort: 'low', format: betaZodOutputFormat(DescriptionSchema) },
          messages: [
            {
              role: 'user',
              content: [
                ...images,
                {
                  type: 'text',
                  text:
                    `These are ${input.kind === 'image' ? 'a still' : 'frames sampled from a short clip'} a creator added as B-roll` +
                    `${input.filename ? ` (file name "${input.filename}")` : ''}. ` +
                    'Write one plain line, at most 15 words, saying what is visible, so an editor can match it to what is being said. No preamble.',
                },
              ],
            },
          ],
        },
        { timeout: opts.timeoutMs ?? 120_000 },
      );
      const parsed = DescriptionSchema.safeParse(res.parsed_output);
      const text = parsed.success ? parsed.data.description.replace(/\s+/g, ' ').trim() : '';
      if (res.stop_reason === 'refusal' || !text) return fallback(input);
      return text.length > 160 ? text.slice(0, 157) + '...' : text;
    } catch {
      return fallback(input);
    }
  };
}
