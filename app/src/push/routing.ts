import { PushData } from '@kilo/edl';

/** Where tapping a notification takes the user, by its PushData type. Null for payloads we do not understand. */
export function routeForPush(data: unknown): string | null {
  const parsed = PushData.safeParse(data);
  if (!parsed.success) return null;
  const d = parsed.data;
  switch (d.type) {
    case 'batch_ready':
      return `/batch/${encodeURIComponent(d.batchId)}`;
    case 'video_failed':
      return `/review/${encodeURIComponent(d.videoId)}`;
    case 'render_done':
      return `/export/${encodeURIComponent(d.videoId)}`;
    case 'goal_reminder':
      return '/';
  }
}
