import { DEFAULT_SETTINGS } from '@kilo/edl';
import { createHttpApi } from './http';
import { KiloApiError } from './errors';
import { routeForPush } from '@/push/routing';

function fakeFetch(status: number, body: unknown) {
  return jest.fn(async (_url: string, _init?: RequestInit) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  })) as unknown as typeof fetch & jest.Mock;
}

describe('HTTP API client', () => {
  it('sends the bearer token and parses the response with its schema', async () => {
    const f = fakeFetch(200, { goal: { videosPerWeek: 3, postedThisWeek: 1, streakWeeks: 0, weekStart: '2026-11-23', reminder: { enabled: false, hour: 9, timeZone: 'UTC' } }, activeBatches: [], readyToReview: [], recent: [] });
    const api = createHttpApi({ baseUrl: 'http://x', getToken: () => 'dev:u1', fetch: f });
    const home = await api.home();
    expect(home.goal.videosPerWeek).toBe(3);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://x/v1/home');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer dev:u1');
  });

  it('turns ApiError bodies into typed errors', async () => {
    const api = createHttpApi({ baseUrl: 'http://x', getToken: () => null, fetch: fakeFetch(409, { error: { code: 'revision_conflict', message: 'stale' } }) });
    const err = await api.getVideo('v1').catch((e) => e);
    expect(err).toBeInstanceOf(KiloApiError);
    expect(err).toMatchObject({ status: 409, code: 'revision_conflict', isConflict: true });
  });

  it('rejects responses that do not match the contract', async () => {
    const api = createHttpApi({ baseUrl: 'http://x', getToken: () => null, fetch: fakeFetch(200, { nope: true }) });
    await expect(api.home()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('validates request bodies before sending', async () => {
    const f = fakeFetch(200, {});
    const api = createHttpApi({ baseUrl: 'http://x', getToken: () => null, fetch: f });
    await expect(api.createBatch({ settings: DEFAULT_SETTINGS, videos: [] })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(f).not.toHaveBeenCalled();
  });

  it('maps network failures and 401s', async () => {
    const onUnauthorized = jest.fn();
    const down = jest.fn(async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    await expect(createHttpApi({ baseUrl: 'http://x', getToken: () => null, fetch: down }).home()).rejects.toMatchObject({ status: 0, code: 'network' });
    const api = createHttpApi({ baseUrl: 'http://x', getToken: () => 'bad', fetch: fakeFetch(401, { error: { code: 'unauthorized', message: 'no' } }), onUnauthorized });
    await expect(api.home()).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalled();
  });

  it('does not sign out when the server could not verify the token (503 auth_unavailable): it is transient', async () => {
    const onUnauthorized = jest.fn();
    const api = createHttpApi({
      baseUrl: 'http://x',
      getToken: () => 'tok',
      fetch: fakeFetch(503, { error: { code: 'auth_unavailable', message: 'Sign-in could not be checked right now.' } }),
      onUnauthorized,
    });
    const err = await api.home().catch((e) => e);
    expect(err).toMatchObject({ status: 503, code: 'auth_unavailable', isTransient: true, isUnauthorized: false });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('sends DELETE /v1/devices on unregister and POST /v1/uploads/targets on reissue', async () => {
    const f = fakeFetch(204, undefined);
    const api = createHttpApi({ baseUrl: 'http://x', getToken: () => 'tok', fetch: f });
    await api.unregisterDevice({ expoPushToken: 'ExponentPushToken[x]' });
    expect(f.mock.calls[0]![0]).toBe('http://x/v1/devices');
    expect(f.mock.calls[0]![1]!.method).toBe('DELETE');
    const g = fakeFetch(200, { clips: [], broll: [] });
    await createHttpApi({ baseUrl: 'http://x', getToken: () => 'tok', fetch: g }).reissueUploads({ clipIds: ['c1'] });
    expect(g.mock.calls[0]![0]).toBe('http://x/v1/uploads/targets');
    expect(JSON.parse(String(g.mock.calls[0]![1]!.body))).toEqual({ clipIds: ['c1'], assetIds: [] });
  });

  it('treats 204 responses as empty', async () => {
    const api = createHttpApi({ baseUrl: 'http://x', getToken: () => null, fetch: fakeFetch(204, undefined) });
    await expect(api.registerDevice({ expoPushToken: 'ExponentPushToken[x]', platform: 'ios' })).resolves.toBeUndefined();
  });
});

describe('push routing', () => {
  it('routes each PushData type', () => {
    expect(routeForPush({ type: 'batch_ready', batchId: 'b1' })).toBe('/batch/b1');
    expect(routeForPush({ type: 'video_failed', videoId: 'v1' })).toBe('/review/v1');
    expect(routeForPush({ type: 'render_done', videoId: 'v1', renderId: 'r1' })).toBe('/export/v1');
    expect(routeForPush({ type: 'goal_reminder' })).toBe('/');
    expect(routeForPush({ type: 'something_else' })).toBeNull();
    expect(routeForPush(undefined)).toBeNull();
  });
});
