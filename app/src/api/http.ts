import {
  AddBrollRequest,
  AddBrollResponse,
  BatchDetail,
  CompleteUploadsRequest,
  CompleteUploadsResponse,
  CreateBatchRequest,
  CreateBatchResponse,
  CreateRenderRequest,
  CreateRenderResponse,
  EdlVersionResponse,
  GoalView,
  HomeResponse,
  ListEdlVersionsResponse,
  ListStylesResponse,
  ListVideosResponse,
  MarkPostedRequest,
  RegisterDeviceRequest,
  ReissueUploadsRequest,
  ReissueUploadsResponse,
  RenderView,
  ReplanRequest,
  RestoreEdlRequest,
  SaveEdlRequest,
  SaveEdlResponse,
  SaveStyleRequest,
  Style,
  UnregisterDeviceRequest,
  UpdateGoalRequest,
  VideoDetail,
  VideoSummary,
} from '@kilo/edl';
import { KiloApiError } from './errors';
import type { KiloApi } from './types';

/** Minimal schema shape so this file does not need its own `zod` import. */
interface Schema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: { message: string } };
}

const HealthResponse: Schema<{ ok: true }> = {
  safeParse: (d) =>
    d && typeof d === 'object' && (d as { ok?: unknown }).ok === true
      ? { success: true, data: { ok: true } }
      : { success: false, error: { message: 'expected { ok: true }' } },
};

export interface HttpApiOptions {
  /** e.g. http://localhost:8787 (no trailing slash, no /v1). */
  baseUrl: string;
  /** Current bearer token, or null when signed out. */
  getToken: () => Promise<string | null> | string | null;
  /** Called on a 401 so the auth layer can sign out or refresh. */
  onUnauthorized?: () => void;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** The real API client. Validates every request body and parses every response with its @kilo/edl schema. */
export function createHttpApi(opts: HttpApiOptions): KiloApi {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  async function request<T>(method: string, path: string, schema: Schema<T> | null, body?: unknown): Promise<T> {
    const token = await opts.getToken();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(`${opts.baseUrl}/v1${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      const aborted = controller.signal.aborted;
      throw new KiloApiError(0, aborted ? 'timeout' : 'network', aborted ? 'The request timed out' : 'Network request failed');
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text().catch(() => '');
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (!res.ok) {
      // Only a token the server rejected (401) signs the user out. 503 `auth_unavailable` means the
      // server could not check it right now: a transient error the caller retries, never a sign-out.
      if (res.status === 401) opts.onUnauthorized?.();
      throw KiloApiError.fromResponse(res.status, json);
    }
    if (schema === null) return undefined as T;
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new KiloApiError(res.status, 'invalid_response', `Unexpected response from ${method} ${path}: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  /** Validates a request body before sending, so contract drift fails loudly in development. */
  function body<T>(schema: { parse(d: unknown): T }, data: unknown): T {
    try {
      return schema.parse(data);
    } catch (e) {
      throw new KiloApiError(0, 'invalid_request', `Invalid request body: ${(e as Error).message}`);
    }
  }

  const enc = encodeURIComponent;

  return {
    health: () => request('GET', '/health', HealthResponse),
    home: () => request('GET', '/home', HomeResponse),

    createBatch: async (b) => request('POST', '/batches', CreateBatchResponse, body(CreateBatchRequest, b)),
    getBatch: (id) => request('GET', `/batches/${enc(id)}`, BatchDetail),
    completeUploads: async (b) => request('POST', '/uploads/complete', CompleteUploadsResponse, body(CompleteUploadsRequest, b)),
    reissueUploads: async (b) => request('POST', '/uploads/targets', ReissueUploadsResponse, body(ReissueUploadsRequest, b)),

    listVideos: (q) => {
      const params = new URLSearchParams();
      if (q?.status) params.set('status', Array.isArray(q.status) ? q.status.join(',') : q.status);
      if (q?.batchId) params.set('batchId', q.batchId);
      if (q?.q?.trim()) params.set('q', q.q.trim());
      if (q?.order) params.set('order', q.order);
      if (q?.limit !== undefined) params.set('limit', String(q.limit));
      if (q?.after) params.set('after', q.after);
      const qs = params.toString();
      return request('GET', `/videos${qs ? `?${qs}` : ''}`, ListVideosResponse);
    },
    getVideo: (id) => request('GET', `/videos/${enc(id)}`, VideoDetail),
    deleteVideo: (id) => request('DELETE', `/videos/${enc(id)}`, null),
    retryVideo: (id) => request('POST', `/videos/${enc(id)}/retry`, VideoSummary),
    saveEdl: async (id, b) => request('PUT', `/videos/${enc(id)}/edl`, SaveEdlResponse, body(SaveEdlRequest, b)),
    listEdlVersions: (id) => request('GET', `/videos/${enc(id)}/edl/versions`, ListEdlVersionsResponse),
    getEdlVersion: (id, revision) => request('GET', `/videos/${enc(id)}/edl/versions/${enc(String(revision))}`, EdlVersionResponse),
    restoreEdl: async (id, b) => request('POST', `/videos/${enc(id)}/edl/restore`, SaveEdlResponse, body(RestoreEdlRequest, b)),
    addBroll: async (id, b) => request('POST', `/videos/${enc(id)}/broll`, AddBrollResponse, body(AddBrollRequest, b)),
    deleteBroll: (id, assetId) => request('DELETE', `/videos/${enc(id)}/broll/${enc(assetId)}`, null),
    replan: async (id, b) => request('POST', `/videos/${enc(id)}/replan`, VideoSummary, body(ReplanRequest, b)),
    createRenders: async (id, b) => request('POST', `/videos/${enc(id)}/renders`, CreateRenderResponse, body(CreateRenderRequest, b)),
    getRender: (id) => request('GET', `/renders/${enc(id)}`, RenderView),
    markPosted: async (id, b) => request('POST', `/videos/${enc(id)}/posted`, VideoSummary, body(MarkPostedRequest, b)),

    getGoal: () => request('GET', '/goal', GoalView),
    updateGoal: async (b) => request('PUT', '/goal', GoalView, body(UpdateGoalRequest, b)),

    listStyles: () => request('GET', '/styles', ListStylesResponse),
    createStyle: async (b) => request('POST', '/styles', Style, body(SaveStyleRequest, b)),
    updateStyle: async (id, b) => request('PUT', `/styles/${enc(id)}`, Style, body(SaveStyleRequest, b)),
    deleteStyle: (id) => request('DELETE', `/styles/${enc(id)}`, null),

    registerDevice: async (b) => request('POST', '/devices', null, body(RegisterDeviceRequest, b)),
    unregisterDevice: async (b) => request('DELETE', '/devices', null, body(UnregisterDeviceRequest, b)),
  };
}
