import type { AnalyzeApi, RenderApi, TemplatesApi } from '@kilo/edl';
import type { AnalyzeExtras, Pipeline } from './types.js';

async function load<T>(pkg: string, exportName: string): Promise<T> {
  let mod: Record<string, unknown>;
  try {
    // A variable specifier keeps TypeScript from needing these packages to typecheck.
    const specifier: string = pkg;
    mod = (await import(specifier)) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not load ${pkg} (${msg}). Install it, or set KILO_PIPELINE=fake.`);
  }
  const value = mod[exportName] ?? (mod.default as Record<string, unknown> | undefined)?.[exportName];
  if (!value || typeof value !== 'object') throw new Error(`${pkg} does not export "${exportName}"`);
  return value as T;
}

/** Loads @kilo/analyze, @kilo/render and @kilo/templates. */
export async function loadRealPipeline(): Promise<Pipeline> {
  const [analyze, render, templates] = await Promise.all([
    load<AnalyzeApi & AnalyzeExtras>('@kilo/analyze', 'analyze'),
    load<RenderApi>('@kilo/render', 'render'),
    load<TemplatesApi>('@kilo/templates', 'templates'),
  ]);
  return { analyze, render, templates };
}
