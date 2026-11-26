import { TEMPLATES, TemplatePropsSchemas, type TemplateId } from '@kilo/edl';

/**
 * Editable forms for the motion graphic templates. Field limits are read from
 * `TemplatePropsSchemas` (the contract), so the form and the server agree; only the
 * labels live here. Pure, so it is unit-tested.
 */

export interface TemplateField {
  key: string;
  label: string;
  kind: 'text' | 'list';
  required: boolean;
  /** Characters per text (each item, for a list). */
  maxLength: number;
  minLength: number;
  /** Lists only. */
  minItems?: number;
  maxItems?: number;
}

export type FormValues = Record<string, string | string[]>;

const LABELS: Record<TemplateId, Record<string, string>> = {
  'bold-title': { text: 'Text' },
  'numbered-list': { title: 'Title', items: 'Items' },
  'stat-callout': { value: 'Number', label: 'Caption' },
  'keyword-pop': { words: 'Words' },
  'price-tag': { price: 'Price', compareAt: 'Was', label: 'Label' },
};

// ---- Reading limits from the zod schemas --------------------------------------

type AnyDef = { typeName?: string; innerType?: AnySchema; type?: AnySchema; minLength?: { value: number } | null; maxLength?: { value: number } | null; checks?: Array<{ kind: string; value: number }>; shape?: () => Record<string, AnySchema> };
type AnySchema = { _def: AnyDef; shape?: Record<string, AnySchema> };

function stringLimits(s: AnySchema): { min: number; max: number } {
  const checks = s._def.checks ?? [];
  const min = checks.find((c) => c.kind === 'min')?.value ?? 0;
  const max = checks.find((c) => c.kind === 'max')?.value ?? 200;
  return { min, max };
}

function fieldsFromSchema(template: TemplateId): TemplateField[] {
  const schema = TemplatePropsSchemas[template] as unknown as AnySchema;
  const shape = schema.shape ?? schema._def.shape?.() ?? {};
  return Object.entries(shape).map(([key, raw]) => {
    let s = raw;
    let required = true;
    if (s._def.typeName === 'ZodOptional') {
      required = false;
      s = s._def.innerType!;
    }
    const label = LABELS[template][key] ?? key;
    if (s._def.typeName === 'ZodArray') {
      const el = stringLimits(s._def.type!);
      return {
        key,
        label,
        kind: 'list' as const,
        required,
        minLength: el.min,
        maxLength: el.max,
        minItems: s._def.minLength?.value ?? 0,
        maxItems: s._def.maxLength?.value ?? 10,
      };
    }
    const lim = stringLimits(s);
    return { key, label, kind: 'text' as const, required: required && lim.min > 0, minLength: lim.min, maxLength: lim.max };
  });
}

/** The editable fields of a template, in schema order. */
export const TEMPLATE_FIELDS: Record<TemplateId, TemplateField[]> = Object.fromEntries(
  TEMPLATES.map((t) => [t.id, fieldsFromSchema(t.id)]),
) as Record<TemplateId, TemplateField[]>;

/** "Up to 60 characters", "2 to 5 items, up to 40 characters each", "Optional, up to 12 characters". */
export function limitText(f: TemplateField): string {
  if (f.kind === 'list') {
    const items = f.minItems === f.maxItems ? `${f.minItems} items` : f.minItems ? `${f.minItems} to ${f.maxItems} items` : `Up to ${f.maxItems} items`;
    return `${items}, up to ${f.maxLength} characters each`;
  }
  return f.required ? `Up to ${f.maxLength} characters` : `Optional, up to ${f.maxLength} characters`;
}

// ---- Form <-> props -------------------------------------------------------------

export function formFromProps(template: TemplateId, props: Record<string, unknown>): FormValues {
  const out: FormValues = {};
  for (const f of TEMPLATE_FIELDS[template]) {
    const v = props[f.key];
    if (f.kind === 'list') out[f.key] = Array.isArray(v) ? v.map(String) : [];
    else out[f.key] = typeof v === 'string' ? v : '';
  }
  return out;
}

export type FormResult = { ok: true; props: Record<string, unknown> } | { ok: false; errors: Record<string, string> };

/**
 * Builds props from the form and checks them against the template's schema.
 * Text is trimmed; empty optional fields are left out; empty list items are dropped.
 */
export function propsFromForm(template: TemplateId, form: FormValues): FormResult {
  const props: Record<string, unknown> = {};
  for (const f of TEMPLATE_FIELDS[template]) {
    const v = form[f.key];
    if (f.kind === 'list') {
      props[f.key] = (Array.isArray(v) ? v : []).map((x) => x.trim()).filter(Boolean);
    } else {
      const t = (typeof v === 'string' ? v : '').trim();
      if (t || f.required) props[f.key] = t;
    }
  }
  const parsed = TemplatePropsSchemas[template].safeParse(props);
  if (parsed.success) return { ok: true, props: parsed.data as Record<string, unknown> };
  const errors: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const key = String(issue.path[0] ?? '');
    if (errors[key]) continue;
    const f = TEMPLATE_FIELDS[template].find((x) => x.key === key);
    errors[key] = f ? fieldError(f, issue.path.length > 1, issue.code) : issue.message;
  }
  return { ok: false, errors };
}

function fieldError(f: TemplateField, itemLevel: boolean, code: string): string {
  if (f.kind === 'list' && !itemLevel) {
    return code === 'too_small' ? `Add at least ${f.minItems} ${f.minItems === 1 ? 'item' : 'items'}` : `At most ${f.maxItems} items`;
  }
  if (code === 'too_small') return itemLevel ? 'Items cannot be empty' : `${f.label} is needed`;
  if (code === 'too_big') return `Up to ${f.maxLength} characters${itemLevel ? ' each' : ''}`;
  return `Check the ${f.label.toLowerCase()}`;
}

/** Characters left in a text field (negative when over). */
export function charsLeft(f: TemplateField, value: string): number {
  return f.maxLength - value.trim().length;
}

// ---- Prefill from what was said ------------------------------------------------

const NUMBER_WORDS: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', fifteen: '15', twenty: '20', thirty: '30', fifty: '50', hundred: '100',
};

function words(text: string): string[] {
  return text.replace(/[“”"]/g, '').split(/\s+/).map((w) => w.trim()).filter(Boolean);
}

/** Cuts text to `max` characters at a word boundary. */
export function fitText(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const space = cut.lastIndexOf(' ');
  return (space > max / 3 ? cut.slice(0, space) : t.slice(0, max)).replace(/[,;:\s]+$/, '');
}

const STOP = new Set(['the', 'and', 'a', 'an', 'it', 'is', 'to', 'of', 'i', "i've", 'you', 'this', 'that', 'for', 'if', 'in', 'on', 'what', 'with', 'about', "it's", "here's", 'okay', 'so', 'every', 'below', 'want']);

/**
 * Props for `template` made from the spoken line, so the form opens filled in.
 * Always valid for the template's schema.
 */
export function prefillProps(template: TemplateId, line: string): Record<string, unknown> {
  const clean = line.replace(/\s+/g, ' ').trim();
  const bare = clean.replace(/[.!?…]+$/, '');
  const fallback = TEMPLATES.find((t) => t.id === template)!.example;
  let props: Record<string, unknown>;
  switch (template) {
    case 'bold-title':
      props = { text: fitText(bare, 60) };
      break;
    case 'numbered-list': {
      const parts = bare.split(/,|;|\band\b|\bthen\b/i).map((p) => fitText(p, 40)).filter(Boolean);
      const items = parts.length >= 2 ? parts.slice(0, 5) : halves(bare).map((p) => fitText(p, 40));
      props = { items };
      break;
    }
    case 'stat-callout': {
      const ws = words(bare);
      const i = ws.findIndex((w) => /\d/.test(w) || NUMBER_WORDS[w.toLowerCase().replace(/[^a-z]/g, '')]);
      if (i >= 0) {
        const raw = ws[i]!.replace(/[^\w$%.,]/g, '');
        const num = NUMBER_WORDS[raw.toLowerCase()] ?? raw;
        const next = (ws[i + 1] ?? '').replace(/[^\w%]/g, '');
        const unit = next && !/\d/.test(next) && !STOP.has(next.toLowerCase()) && num.length + 1 + next.length <= 10 ? ` ${next}` : '';
        const value = fitText(`${num}${unit}`, 10);
        const rest = ws.slice(i + (unit ? 2 : 1)).join(' ') || ws.slice(0, i).join(' ');
        props = { value, label: fitText(rest || 'and counting', 50) };
      } else {
        props = { ...fallback };
      }
      break;
    }
    case 'keyword-pop': {
      const picked = words(bare)
        .map((w) => w.replace(/[^\w'’-]/g, ''))
        .filter((w) => w.length > 2 && w.length <= 18 && !STOP.has(w.toLowerCase()));
      const chosen = [...new Set(picked)].sort((a, b) => b.length - a.length).slice(0, 2);
      const ordered = picked.filter((w, k) => chosen.includes(w) && picked.indexOf(w) === k);
      props = { words: ordered.length ? ordered : ['this'] };
      break;
    }
    case 'price-tag': {
      const prices = clean.match(/[$£€]\s?\d+(?:[.,]\d{1,2})?/g) ?? [];
      props = prices.length
        ? { price: prices[0]!.replace(/\s/g, ''), ...(prices[1] ? { compareAt: prices[1].replace(/\s/g, '') } : {}) }
        : { price: String((fallback as { price: string }).price) };
      break;
    }
  }
  const parsed = TemplatePropsSchemas[template].safeParse(props);
  return parsed.success ? (parsed.data as Record<string, unknown>) : { ...fallback };
}

function halves(text: string): string[] {
  const ws = words(text);
  if (ws.length < 2) return [text || 'First', 'Second'];
  const mid = Math.ceil(ws.length / 2);
  return [ws.slice(0, mid).join(' '), ws.slice(mid).join(' ')];
}
