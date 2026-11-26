import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GoalView, HomeResponse } from '@kilo/edl';
import { goalStats, isBehindPace, localTime, weekStartOf } from '../src/goal.js';
import { createEnv, newUser, type Client, type TestEnv } from './helpers.js';

const at = (iso: string) => new Date(iso);
const post = (iso: string, videoId: string | null = randomUUID()) => ({ videoId, postedAt: at(iso) });

describe('goal maths', () => {
  it('finds the local Monday in any time zone', () => {
    // Monday 2026-11-23 00:30 in Tokyo is still Sunday 22nd in UTC.
    expect(localTime(at('2026-11-22T15:30:00Z'), 'Asia/Tokyo')).toEqual({ date: '2026-11-23', hour: 0, weekday: 0 });
    expect(localTime(at('2026-11-22T15:30:00Z'), 'UTC')).toEqual({ date: '2026-11-22', hour: 15, weekday: 6 });
    expect(weekStartOf('2026-11-22')).toBe('2026-11-16');
    expect(weekStartOf('2026-11-23')).toBe('2026-11-23');
    expect(weekStartOf('2027-01-01')).toBe('2026-12-28');
    // Half-hour zones.
    expect(localTime(at('2026-11-23T18:29:00Z'), 'Asia/Kolkata').date).toBe('2026-11-23');
    expect(localTime(at('2026-11-23T18:30:00Z'), 'Asia/Kolkata')).toEqual({ date: '2026-11-24', hour: 0, weekday: 1 });
  });

  it('counts posts per local week, a video once', () => {
    const now = at('2026-11-26T12:00:00Z'); // Thursday
    const v = randomUUID();
    const posts = [
      post('2026-11-23T00:30:00Z', v),
      post('2026-11-24T10:00:00Z', v), // same video on another platform
      post('2026-11-22T23:30:00Z'), // Sunday night UTC = last week in UTC, this week in Berlin
    ];
    expect(goalStats(posts, 3, 'UTC', now)).toMatchObject({ weekStart: '2026-11-23', postedThisWeek: 1 });
    expect(goalStats(posts, 3, 'Europe/Berlin', now)).toMatchObject({ weekStart: '2026-11-23', postedThisWeek: 2 });
    // In Los Angeles, Monday 00:30 UTC is still Sunday: only the Tuesday post is this week.
    expect(goalStats(posts, 3, 'America/Los_Angeles', now)).toMatchObject({ weekStart: '2026-11-23', postedThisWeek: 1 });
  });

  it('streaks count consecutive past weeks that met the goal', () => {
    const now = at('2026-11-26T12:00:00Z');
    const weeks = ['2026-11-17', '2026-11-10', '2026-11-03', '2026-10-20'];
    const posts = weeks.flatMap((d) => [post(`${d}T12:00:00Z`), post(`${d}T13:00:00Z`)]);
    // Two a week for three consecutive weeks, then a gap in the week of Oct 27.
    expect(goalStats(posts, 2, 'UTC', now).streakWeeks).toBe(3);
    expect(goalStats(posts, 3, 'UTC', now).streakWeeks).toBe(0);
    expect(goalStats(posts, 0, 'UTC', now).streakWeeks).toBe(0);
    // This week's posts never count toward the streak.
    expect(goalStats([...posts, post('2026-11-24T10:00:00Z'), post('2026-11-25T10:00:00Z')], 2, 'UTC', now).streakWeeks).toBe(3);
    // Across a DST change (Europe ends DST on 2026-10-25) the weeks still line up.
    // Monday 26 Oct 00:30 in Paris is still Sunday in UTC.
    const dst = [post('2026-10-25T23:30:00Z')];
    expect(goalStats(dst, 1, 'Europe/Paris', at('2026-11-04T12:00:00Z'))).toMatchObject({ weekStart: '2026-11-02', streakWeeks: 1 });
    expect(goalStats(dst, 1, 'UTC', at('2026-11-04T12:00:00Z'))).toMatchObject({ weekStart: '2026-11-02', streakWeeks: 0 });
  });

  it('behind pace means fewer posts than the goal pro-rated to tonight', () => {
    expect(isBehindPace(0, 3, 0)).toBe(true); // Monday: 1 due
    expect(isBehindPace(1, 3, 0)).toBe(false);
    expect(isBehindPace(1, 3, 2)).toBe(true); // Wednesday: 2 due
    expect(isBehindPace(2, 3, 5)).toBe(true); // Saturday: 3 due
    expect(isBehindPace(3, 3, 6)).toBe(false);
    expect(isBehindPace(0, 0, 6)).toBe(false);
    expect(isBehindPace(0, 1, 0)).toBe(true);
  });
});

describe('goal API and reminders', () => {
  let env: TestEnv;
  let user: Client;

  beforeAll(async () => {
    env = await createEnv({ workers: false });
    user = env.as(newUser());
  });
  afterAll(async () => {
    await env?.stop();
  });

  const addPost = (userId: string, iso: string) =>
    env.sql`insert into posts (id, user_id, video_id, platform, posted_at) values (${randomUUID()}, ${userId}, null, 'tiktok', ${at(iso)})`;

  it('GET /v1/goal follows the clock across a week boundary in the reminder zone', async () => {
    await user.ok(GoalView, 'PUT', '/v1/goal', { videosPerWeek: 1, reminder: { enabled: false, hour: 9, timeZone: 'America/New_York' } });
    await addPost(user.userId, '2026-11-20T15:00:00Z'); // Friday, week of Nov 16
    // Sunday 23:30 in New York (Monday 04:30 UTC): still the week of Nov 16.
    env.clock.now = at('2026-11-23T04:30:00Z');
    let goal = await user.ok(GoalView, 'GET', '/v1/goal');
    expect(goal).toMatchObject({ weekStart: '2026-11-16', postedThisWeek: 1, streakWeeks: 0 });
    // An hour later it is Monday: the post is last week's, and the streak is 1.
    env.clock.now = at('2026-11-23T05:30:00Z');
    goal = await user.ok(GoalView, 'GET', '/v1/goal');
    expect(goal).toMatchObject({ weekStart: '2026-11-23', postedThisWeek: 0, streakWeeks: 1 });
    expect((await user.ok(HomeResponse, 'GET', '/v1/home')).goal).toEqual(goal);
    env.clock.now = null;
  });

  it('sends goal_reminder at the local hour when behind pace, at most once a day', async () => {
    const behind = env.as(newUser());
    const onTrack = env.as(newUser());
    const disabled = env.as(newUser());
    const reminder = { enabled: true, hour: 18, timeZone: 'Asia/Tokyo' };
    await behind.ok(GoalView, 'PUT', '/v1/goal', { videosPerWeek: 3, reminder });
    await onTrack.ok(GoalView, 'PUT', '/v1/goal', { videosPerWeek: 3, reminder });
    await disabled.ok(GoalView, 'PUT', '/v1/goal', { videosPerWeek: 3, reminder: { ...reminder, enabled: false } });
    // Wednesday 25 Nov in Tokyo: two are due by tonight.
    await addPost(onTrack.userId, '2026-11-23T03:00:00Z');
    await addPost(onTrack.userId, '2026-11-24T03:00:00Z');
    await addPost(behind.userId, '2026-11-23T03:00:00Z');
    await env.sql`insert into devices (id, user_id, expo_push_token, platform) values (${randomUUID()}, ${behind.userId}, 'ExponentPushToken[behind]', 'ios')`;

    const sentTo = () => env.push.sent.filter((s) => s.message.data.type === 'goal_reminder').map((s) => s.tokens);
    // 17:00 Tokyo: not the hour yet.
    expect(await env.worker.runGoalReminders(at('2026-11-25T08:00:00Z'))).toBe(0);
    // 18:00 Tokyo.
    expect(await env.worker.runGoalReminders(at('2026-11-25T09:00:00Z'))).toBe(1);
    expect(sentTo()).toEqual([['ExponentPushToken[behind]']]);
    // The same hour again (a duplicate or overlapping run) sends nothing.
    expect(await env.worker.runGoalReminders(at('2026-11-25T09:20:00Z'))).toBe(0);
    await Promise.all([
      env.worker.runGoalReminders(at('2026-11-25T09:40:00Z')),
      env.worker.runGoalReminders(at('2026-11-25T09:40:00Z')),
    ]);
    expect(sentTo()).toHaveLength(1);
    // Next day, still behind (Thursday: 2 due, has 1): one more.
    expect(await env.worker.runGoalReminders(at('2026-11-26T09:00:00Z'))).toBe(1);
    expect(sentTo()).toHaveLength(2);
    // Goal met: no more reminders.
    await addPost(behind.userId, '2026-11-26T10:00:00Z');
    await addPost(behind.userId, '2026-11-26T11:00:00Z');
    await addPost(onTrack.userId, '2026-11-26T11:00:00Z');
    expect(await env.worker.runGoalReminders(at('2026-11-27T09:00:00Z'))).toBe(0);
  });
});
