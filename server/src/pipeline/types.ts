import type { AnalyzeApi, DecideInput, Edl, RenderApi, TemplatesApi } from '@kilo/edl';

/** Something the creator should know about a decided edit (from @kilo/analyze's decideEditWithNotices). */
export interface DecideNotice {
  code: string;
  /** Safe to show the user. */
  message: string;
}

/** The parts of @kilo/analyze's `Analyze` beyond the shared contract that the server uses when present. */
export interface AnalyzeExtras {
  decideEditWithNotices?(input: DecideInput): Promise<{ edl: Edl; notices: DecideNotice[] }>;
  /** Which transcriber and decider are active and which are offline stand-ins. Never includes keys. */
  describeProviders?(): { standIns: string[]; summary: string };
}

/** The three pipeline projects, injected into the API, the worker and the CLI. */
export interface Pipeline {
  analyze: AnalyzeApi & AnalyzeExtras;
  render: RenderApi;
  templates: TemplatesApi;
}
