import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import {
  RegisterDeviceRequest,
  UnregisterDeviceRequest,
  SaveStyleRequest,
  UpdateGoalRequest,
  type HomeResponse,
  type ListStylesResponse,
} from '@kilo/edl';
import { invalidRequest, notFound } from '../errors.js';
import { isValidTimeZone } from '../goal.js';
import { batchSummaries, goalView, styleView, videoSummaries, type StyleRow } from '../views.js';
import { pathId, parseBody, type AppDeps, type Env } from './app.js';

/** Goal, styles, devices and the home screen. */
export function userRoutes(deps: AppDeps): Hono<Env> {
  const { db, storage } = deps;
  const now = () => deps.now?.() ?? new Date();
  const app = new Hono<Env>();

  app.get('/goal', async (c) => c.json(await goalView(db, c.get('userId'), now())));

  app.put('/goal', async (c) => {
    const userId = c.get('userId');
    const req = await parseBody(c, UpdateGoalRequest);
    if (!isValidTimeZone(req.reminder.timeZone)) throw invalidRequest('reminder.timeZone: not an IANA time zone');
    await db`
      insert into goals (user_id, videos_per_week, reminder_enabled, reminder_hour, time_zone)
      values (${userId}, ${req.videosPerWeek}, ${req.reminder.enabled}, ${req.reminder.hour}, ${req.reminder.timeZone})
      on conflict (user_id) do update set
        videos_per_week = excluded.videos_per_week,
        reminder_enabled = excluded.reminder_enabled,
        reminder_hour = excluded.reminder_hour,
        -- A new zone means a new local calendar: forget which day was last reminded.
        last_reminded_on = case when goals.time_zone = excluded.time_zone then goals.last_reminded_on end,
        time_zone = excluded.time_zone,
        updated_at = now()`;
    return c.json(await goalView(db, userId, now()));
  });

  app.get('/styles', async (c) => {
    const rows = await db<StyleRow[]>`select * from styles where user_id = ${c.get('userId')} order by created_at, id`;
    const body: ListStylesResponse = { styles: rows.map(styleView) };
    return c.json(body);
  });

  app.post('/styles', async (c) => {
    const userId = c.get('userId');
    const req = await parseBody(c, SaveStyleRequest);
    const row = await db.begin(async (tx) => {
      // Serialise default changes per user.
      await tx`select pg_advisory_xact_lock(hashtext(${userId}))`;
      if (req.isDefault) await tx`update styles set is_default = false where user_id = ${userId} and is_default`;
      const [r] = await tx<StyleRow[]>`
        insert into styles (id, user_id, name, settings, is_default)
        values (${randomUUID()}, ${userId}, ${req.name}, ${tx.json(req.settings as never)}, ${req.isDefault})
        returning *`;
      return r!;
    });
    return c.json(styleView(row), 201);
  });

  app.put('/styles/:id', async (c) => {
    const userId = c.get('userId');
    const id = pathId(c, 'id', 'Style');
    const req = await parseBody(c, SaveStyleRequest);
    const row = await db.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${userId}))`;
      const [existing] = await tx`select id from styles where id = ${id} and user_id = ${userId}`;
      if (!existing) throw notFound('Style');
      if (req.isDefault) await tx`update styles set is_default = false where user_id = ${userId} and is_default and id <> ${id}`;
      const [r] = await tx<StyleRow[]>`
        update styles set name = ${req.name}, settings = ${tx.json(req.settings as never)}, is_default = ${req.isDefault}, updated_at = now()
        where id = ${id} returning *`;
      return r!;
    });
    return c.json(styleView(row));
  });

  app.delete('/styles/:id', async (c) => {
    const id = pathId(c, 'id', 'Style');
    const [row] = await db`delete from styles where id = ${id} and user_id = ${c.get('userId')} returning id`;
    if (!row) throw notFound('Style');
    return c.body(null, 204);
  });

  /**
   * A token stays with the account that registered it. Another account can take it
   * over only after the first one let go of it (`DELETE /devices`, which the app
   * sends on sign-out); until then a second registration is a quiet no-op, so
   * knowing someone's push token is not enough to receive their notifications.
   */
  app.post('/devices', async (c) => {
    const userId = c.get('userId');
    const req = await parseBody(c, RegisterDeviceRequest);
    if (!req.expoPushToken.trim()) throw invalidRequest('expoPushToken: required');
    const rows = await db`
      insert into devices (id, user_id, expo_push_token, platform)
      values (${randomUUID()}, ${userId}, ${req.expoPushToken}, ${req.platform})
      on conflict (expo_push_token) do update set platform = excluded.platform, updated_at = now()
        where devices.user_id = excluded.user_id
      returning id`;
    if (!rows.length) deps.log.warn('push token already registered to another account; not moved', { userId });
    return c.body(null, 204);
  });

  /** Sign-out: this device stops getting the caller's notifications. Only the caller's own registration is removed. */
  app.delete('/devices', async (c) => {
    const userId = c.get('userId');
    const req = await parseBody(c, UnregisterDeviceRequest);
    await db`delete from devices where expo_push_token = ${req.expoPushToken} and user_id = ${userId}`;
    return c.body(null, 204);
  });

  app.get('/home', async (c) => {
    const userId = c.get('userId');
    const active = await db<{ id: string }[]>`
      select distinct batch_id as id from videos
      where user_id = ${userId} and status in ('uploading', 'queued', 'analyzing')`;
    const [goal, activeBatches, readyToReview, recent] = await Promise.all([
      goalView(db, userId, now()),
      active.length ? batchSummaries(db, userId, active.map((r) => r.id)) : Promise.resolve([]),
      videoSummaries(db, storage, db`v.user_id = ${userId} and v.status = 'ready_for_review'`),
      videoSummaries(db, storage, db`v.user_id = ${userId} and v.status = 'done'`, 'updated', 20),
    ]);
    const body: HomeResponse = { goal, activeBatches, readyToReview, recent };
    return c.json(body);
  });

  return app;
}
