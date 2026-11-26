import { z } from 'zod';

/**
 * The motion graphic catalog. The decider picks a template id and fills `props`;
 * the `templates/` project renders each id. Adding a template means adding an
 * entry here and a renderer there.
 */

export const TemplateId = z.enum(['bold-title', 'numbered-list', 'stat-callout', 'keyword-pop', 'price-tag']);
export type TemplateId = z.infer<typeof TemplateId>;

export const TemplatePropsSchemas = {
  'bold-title': z.object({
    text: z.string().min(1).max(60),
  }),
  'numbered-list': z.object({
    title: z.string().max(40).optional(),
    items: z.array(z.string().min(1).max(40)).min(2).max(5),
  }),
  'stat-callout': z.object({
    value: z.string().min(1).max(10),
    label: z.string().min(1).max(50),
  }),
  'keyword-pop': z.object({
    words: z.array(z.string().min(1).max(18)).min(1).max(4),
  }),
  'price-tag': z.object({
    price: z.string().min(1).max(12),
    compareAt: z.string().max(12).optional(),
    label: z.string().max(40).optional(),
  }),
} as const satisfies Record<TemplateId, z.ZodTypeAny>;

export type TemplateProps = { [K in TemplateId]: z.infer<(typeof TemplatePropsSchemas)[K]> };

export type TemplatePlacement = 'fullscreen' | 'upper' | 'lower';

export interface TemplateSpec {
  id: TemplateId;
  name: string;
  /** Shown to the decider so it knows when to use the template. */
  description: string;
  /** `fullscreen` templates cover the speaker; the others sit over the footage with alpha. */
  placement: TemplatePlacement;
  defaultDurationSec: number;
  minDurationSec: number;
  maxDurationSec: number;
  example: Record<string, unknown>;
}

export const TEMPLATES: readonly TemplateSpec[] = [
  {
    id: 'bold-title',
    name: 'Bold title',
    description: 'A short punchy phrase filling the screen. Use for the hook or a section break.',
    placement: 'fullscreen',
    defaultDurationSec: 1.6,
    minDurationSec: 1.0,
    maxDurationSec: 3.0,
    example: { text: 'Nobody tells you this' },
  },
  {
    id: 'numbered-list',
    name: 'Numbered list',
    description: 'Two to five short items that appear one by one. Use when the speaker lists steps or reasons.',
    placement: 'fullscreen',
    defaultDurationSec: 3.5,
    minDurationSec: 2.0,
    maxDurationSec: 6.0,
    example: { title: 'Three mistakes', items: ['Too much product', 'Wrong order', 'Skipping SPF'] },
  },
  {
    id: 'stat-callout',
    name: 'Stat callout',
    description: 'One big number with a caption underneath. Use when the speaker says a figure.',
    placement: 'upper',
    defaultDurationSec: 2.0,
    minDurationSec: 1.2,
    maxDurationSec: 4.0,
    example: { value: '10 sec', label: 'is all it takes' },
  },
  {
    id: 'keyword-pop',
    name: 'Keyword pop',
    description: 'One to four emphasised words that pop in over the footage in time with speech.',
    placement: 'lower',
    defaultDurationSec: 1.4,
    minDurationSec: 0.8,
    maxDurationSec: 3.0,
    example: { words: ['actually', 'works'] },
  },
  {
    id: 'price-tag',
    name: 'Price tag',
    description: 'A price, optionally with a struck-through compare-at price. Use for offers and TikTok Shop videos.',
    placement: 'upper',
    defaultDurationSec: 2.2,
    minDurationSec: 1.2,
    maxDurationSec: 4.0,
    example: { price: '$19', compareAt: '$34', label: 'Today only' },
  },
];

export function getTemplate(id: TemplateId): TemplateSpec {
  const spec = TEMPLATES.find((t) => t.id === id);
  if (!spec) throw new Error(`Unknown template: ${id}`);
  return spec;
}

/** Parses props for a template. Throws a ZodError when they do not fit. */
export function parseTemplateProps<K extends TemplateId>(id: K, props: unknown): TemplateProps[K] {
  return TemplatePropsSchemas[id].parse(props) as TemplateProps[K];
}

/** Colours and type a set of graphics shares, so every graphic in a video matches. */
export const GraphicTheme = z.object({
  id: z.string(),
  name: z.string(),
  fontFamily: z.string(),
  background: z.string(),
  foreground: z.string(),
  accent: z.string(),
});
export type GraphicTheme = z.infer<typeof GraphicTheme>;

export const GRAPHIC_THEMES: readonly GraphicTheme[] = [
  { id: 'clean', name: 'Clean', fontFamily: 'Inter', background: '#FFFFFF', foreground: '#0B1220', accent: '#1F5EFF' },
  { id: 'ink', name: 'Ink', fontFamily: 'Inter', background: '#0B1220', foreground: '#FFFFFF', accent: '#7CA7FF' },
  { id: 'pop', name: 'Pop', fontFamily: 'Inter', background: '#FFE94A', foreground: '#0B1220', accent: '#F0442E' },
];

export function getGraphicTheme(id: string): GraphicTheme {
  return GRAPHIC_THEMES.find((t) => t.id === id) ?? GRAPHIC_THEMES[0]!;
}
