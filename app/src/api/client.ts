import { env } from '@/lib/env';
import { createHttpApi } from './http';
import type { KiloApi } from './types';
import { MockKiloApi } from './mock/mockApi';
import { bundledMockMedia } from './mock/media';

/**
 * The one API instance the app uses. EXPO_PUBLIC_MOCK=1 selects the in-memory mock;
 * otherwise the HTTP client against EXPO_PUBLIC_API_URL with the token from the
 * auth layer (set with `setTokenProvider`).
 */
let tokenProvider: () => Promise<string | null> | string | null = () => null;
let unauthorizedHandler: () => void = () => undefined;

export function setTokenProvider(fn: typeof tokenProvider): void {
  tokenProvider = fn;
}

export function setUnauthorizedHandler(fn: () => void): void {
  unauthorizedHandler = fn;
}

let instance: KiloApi | null = null;
let mockInstance: MockKiloApi | null = null;

export function getApi(): KiloApi {
  if (instance) return instance;
  if (env.mock) {
    mockInstance = new MockKiloApi({ media: bundledMockMedia(), latencyMs: 150, seed: !isFirstRunMock() });
    instance = mockInstance;
    // Mock mode only: lets browser drives (app/.work/*.mjs) read what the app saved.
    (globalThis as { __kiloMock?: MockKiloApi }).__kiloMock = mockInstance;
  } else {
    instance = createHttpApi({
      baseUrl: env.apiUrl,
      getToken: () => tokenProvider(),
      onUnauthorized: () => unauthorizedHandler(),
    });
  }
  return instance;
}

/** The mock, when mock mode is on (for dev tools and screenshots). */
export function getMockApi(): MockKiloApi | null {
  getApi();
  return mockInstance;
}

/** `?fresh=1` in the web URL starts the mock as a first-time user (empty state). */
function isFirstRunMock(): boolean {
  const loc = (globalThis as { location?: { search?: string } }).location;
  return typeof loc?.search === 'string' && /[?&]fresh=1/.test(loc.search);
}
