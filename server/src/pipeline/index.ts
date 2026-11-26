import type { Config } from '../config.js';
import { createFakePipeline } from './fake.js';
import { loadRealPipeline } from './real.js';
import type { Pipeline } from './types.js';

export type { Pipeline } from './types.js';

export async function loadPipeline(kind: Config['pipeline']): Promise<Pipeline> {
  return kind === 'fake' ? createFakePipeline() : loadRealPipeline();
}
