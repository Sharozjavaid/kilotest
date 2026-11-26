import { GraphicTheme, TemplateId, getTemplate, parseTemplateProps } from '@kilo/edl';
import type { RenderGraphicRequest, TemplateSpec } from '@kilo/edl';

/** A request after validation: props parsed, theme checked, numbers sane. */
export interface NormalizedRequest {
  template: TemplateId;
  spec: TemplateSpec;
  props: Record<string, unknown>;
  theme: GraphicTheme;
  /** The requested duration clamped to the template's catalog min..max. */
  durationSec: number;
  fps: number;
  width: number;
  height: number;
  /** round(durationSec * fps) after clamping. */
  frames: number;
}

export class TemplateRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateRequestError';
  }
}

interface ZodLikeError {
  name: string;
  issues: Array<{ path: Array<string | number>; message: string }>;
}

/** `@kilo/edl` bundles its own zod, so match its errors by shape rather than by class. */
function isZodError(err: unknown): err is ZodLikeError {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'ZodError' && Array.isArray((err as { issues?: unknown }).issues);
}

function describeZod(err: ZodLikeError): string {
  return err.issues.map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`).join('; ');
}

export function normalizeRequest(req: Omit<RenderGraphicRequest, 'outPath'>): NormalizedRequest {
  const id = TemplateId.safeParse(req.template);
  if (!id.success) throw new TemplateRequestError(`Unknown template "${String(req.template)}". Expected one of: ${TemplateId.options.join(', ')}.`);
  const template = id.data;
  let props: Record<string, unknown>;
  try {
    props = parseTemplateProps(template, req.props) as Record<string, unknown>;
  } catch (err) {
    if (isZodError(err)) throw new TemplateRequestError(`Invalid props for template "${template}": ${describeZod(err)}`);
    throw err;
  }
  const theme = GraphicTheme.safeParse(req.theme);
  if (!theme.success) throw new TemplateRequestError(`Invalid theme: ${describeZod(theme.error)}`);

  const { durationSec, fps, width, height } = req;
  if (!(typeof fps === 'number' && Number.isFinite(fps) && fps > 0 && fps <= 240)) throw new TemplateRequestError(`Invalid fps: ${fps}`);
  if (!(typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec > 0 && durationSec <= 60)) {
    throw new TemplateRequestError(`Invalid durationSec: ${durationSec}`);
  }
  for (const [name, v] of [['width', width], ['height', height]] as const) {
    if (!(Number.isInteger(v) && v >= 16 && v <= 8192)) throw new TemplateRequestError(`Invalid ${name}: ${v} (an integer from 16 to 8192)`);
  }
  // Outside the catalog range the timings would be squeezed or stretched past what the
  // template was designed for: render at the nearest length it supports instead.
  const spec = getTemplate(template);
  const clamped = Math.min(spec.maxDurationSec, Math.max(spec.minDurationSec, durationSec));
  const frames = Math.max(1, Math.round(clamped * fps));
  return { template, spec, props, theme: theme.data, durationSec: clamped, fps, width, height, frames };
}
