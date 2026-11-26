import type { PushData } from '@kilo/edl';
import type { Db } from './db/index.js';
import type { Logger } from './log.js';

export interface PushMessage {
  title: string;
  body: string;
  data: PushData;
}

export interface PushResult {
  /** Tokens the provider says are no longer registered; the caller forgets them. */
  invalidTokens: string[];
}

export interface PushProvider {
  readonly name: string;
  send(tokens: string[], message: PushMessage): Promise<PushResult>;
}

/** Writes notifications to the log. The default in tests and when a user has no devices. */
export class LogPush implements PushProvider {
  readonly name = 'log';
  readonly sent: { tokens: string[]; message: PushMessage }[] = [];
  constructor(private readonly log?: Logger) {}
  async send(tokens: string[], message: PushMessage): Promise<PushResult> {
    this.sent.push({ tokens, message });
    this.log?.info('push', { provider: 'log', type: message.data.type, devices: tokens.length });
    return { invalidTokens: [] };
  }
}

/**
 * Expo push service. `EXPO_ACCESS_TOKEN` is optional (needed only when the Expo
 * project enforces push security). Not yet exercised against the real Expo
 * service; tested against a mocked fetch.
 */
export class ExpoPush implements PushProvider {
  readonly name = 'expo';
  constructor(
    private readonly accessToken?: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly endpoint = 'https://exp.host/--/api/v2/push/send',
  ) {}

  async send(tokens: string[], message: PushMessage): Promise<PushResult> {
    const invalidTokens: string[] = [];
    for (let i = 0; i < tokens.length; i += 100) {
      const chunk = tokens.slice(i, i + 100);
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
      if (this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(
          chunk.map((to) => ({ to, title: message.title, body: message.body, data: message.data, sound: 'default' })),
        ),
      });
      if (!res.ok) throw new Error(`Expo push failed: ${res.status}`);
      const body = (await res.json()) as {
        data?: { status: 'ok' | 'error'; details?: { error?: string } }[];
      };
      body.data?.forEach((ticket, j) => {
        if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') invalidTokens.push(chunk[j]!);
      });
    }
    return { invalidTokens };
  }
}

const TEXT: Record<PushData['type'], { title: string; body: string }> = {
  batch_ready: { title: 'Your videos are ready', body: 'Your batch finished. Tap to review the cuts.' },
  video_failed: { title: 'A video needs attention', body: 'One of your videos could not be processed.' },
  render_done: { title: 'Export ready', body: 'Your video is ready to save and post.' },
  goal_reminder: { title: 'Keep your streak going', body: 'You are behind on this week\'s goal. Post one today.' },
};

/** Sends a push to every device of a user. Never throws: notification failures are logged. */
export class Notifier {
  constructor(
    private readonly db: Db,
    private readonly provider: PushProvider,
    private readonly log: Logger,
    private readonly fallback: PushProvider = new LogPush(log),
  ) {}

  async notify(userId: string, data: PushData): Promise<void> {
    try {
      const rows = await this.db<{ expo_push_token: string }[]>`
        select expo_push_token from devices where user_id = ${userId}`;
      const tokens = rows.map((r) => r.expo_push_token);
      const message = { ...TEXT[data.type], data };
      const provider = tokens.length ? this.provider : this.fallback;
      const result = await provider.send(tokens, message);
      if (result.invalidTokens.length) {
        await this.db`delete from devices where expo_push_token in ${this.db(result.invalidTokens)}`;
      }
    } catch (err) {
      this.log.error('push failed', { type: data.type, err: err instanceof Error ? err.message : String(err) });
    }
  }
}
