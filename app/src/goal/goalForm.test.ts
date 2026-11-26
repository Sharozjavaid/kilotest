import { UpdateGoalRequest, type GoalView } from '@kilo/edl';
import { formatHour, goalFormFrom, goalHeadline, goalSummary, isDirty, streakLine, toUpdateRequest, withHour, withPerWeek } from './goalForm';

const view: GoalView = { videosPerWeek: 5, postedThisWeek: 2, streakWeeks: 3, weekStart: '2026-11-23', reminder: { enabled: true, hour: 18, timeZone: 'Europe/London' } };

describe('goal form', () => {
  it('loads from the server and is clean until changed', () => {
    const f = goalFormFrom(view);
    expect(f).toEqual({ videosPerWeek: 5, reminderEnabled: true, hour: 18 });
    expect(isDirty(f, view, 'Europe/London')).toBe(false);
    expect(isDirty(withHour(f, 9), view, 'Europe/London')).toBe(true);
    // A new device time zone is saved with the reminder.
    expect(isDirty(f, view, 'America/New_York')).toBe(true);
  });

  it('0 videos a week turns the goal and the reminder off', () => {
    const f = withPerWeek(goalFormFrom(view), 0);
    expect(f.reminderEnabled).toBe(false);
    const req = toUpdateRequest({ ...f, reminderEnabled: true }, 'UTC');
    expect(req.reminder.enabled).toBe(false);
    expect(UpdateGoalRequest.safeParse(req).success).toBe(true);
  });

  it('clamps the target and wraps the hour', () => {
    const f = goalFormFrom(view);
    expect(withPerWeek(f, 99).videosPerWeek).toBe(50);
    expect(withPerWeek(f, -1).videosPerWeek).toBe(0);
    expect(withHour(f, 24).hour).toBe(0);
    expect(withHour(f, -1).hour).toBe(23);
  });

  it('sends the device time zone', () => {
    expect(toUpdateRequest(goalFormFrom(view), 'Asia/Tokyo')).toEqual({ videosPerWeek: 5, reminder: { enabled: true, hour: 18, timeZone: 'Asia/Tokyo' } });
  });

  it('formats hours and summaries', () => {
    expect([0, 9, 12, 18, 23].map(formatHour)).toEqual(['12 am', '9 am', '12 pm', '6 pm', '11 pm']);
    expect(goalHeadline(view)).toBe('2 of 5 videos posted');
    expect(goalHeadline({ videosPerWeek: 0, postedThisWeek: 0 })).toBe('No weekly goal');
    expect(streakLine(0)).toBe('No streak yet');
    expect(streakLine(1)).toBe('1 week in a row');
    expect(goalSummary(view)).toBe('5 a week · reminder 6 pm');
    expect(goalSummary({ ...view, videosPerWeek: 0 })).toBe('Goal off');
  });
});
