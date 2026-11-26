import type { AnalyzeApi, RenderApi, TemplatesApi } from '@kilo/edl';

/** The three pipeline projects, injected into the API, the worker and the CLI. */
export interface Pipeline {
  analyze: AnalyzeApi;
  render: RenderApi;
  templates: TemplatesApi;
}
