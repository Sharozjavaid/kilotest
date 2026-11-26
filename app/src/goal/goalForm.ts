import type { GoalView, UpdateGoalRequest } from '@kilo/edl';

/** The weekly goal form (PUT /v1/goal). Pure, so it is unit-tested. */

export const MAX_PER_WEEK = 50;

export interface GoalForm {
  /** 0 turns the goal off. */
  videosPerWeek: number;
  reminderEnabled: boolean;
  /** Local hour, 0..23. */
  hour: number;
}

export function goalFormFrom(view: GoalView): GoalForm {
  return { videosPerWeek: view.videosPerWeek, reminderEnabled: view.reminder.enabled && view.videosPerWeek > 0, hour: view.reminder.hour };
}

/** Changing the target; 0 turns the goal off, and with it the reminder. */
export function withPerWeek(form: GoalForm, n: number): GoalForm {
  const videosPerWeek = Math.max(0, Math.min(MAX_PER_WEEK, Math.round(n)));
  return { ...form, videosPerWeek, reminderEnabled: videosPerWeek === 0 ? false : form.reminderEnabled };
}

/** Steps the reminder hour, wrapping around midnight. */
export function withHour(form: GoalForm, hour: number): GoalForm {
  return { ...form, hour: ((Math.round(hour) % 24) + 24) % 24 };
}

/** The request, with the device's time zone so reminders arrive at the local hour. */
export function toUpdateRequest(form: GoalForm, timeZone: string): UpdateGoalRequest {
  return {
    videosPerWeek: form.videosPerWeek,
    reminder: { enabled: form.videosPerWeek > 0 && form.reminderEnabled, hour: form.hour, timeZone },
  };
}

export function isDirty(form: GoalForm, view: GoalView, timeZone: string): boolean {
  const req = toUpdateRequest(form, timeZone);
  return (
    req.videosPerWeek !== view.videosPerWeek ||
    req.reminder.enabled !== view.reminder.enabled ||
    (req.reminder.enabled && (req.reminder.hour !== view.reminder.hour || req.reminder.timeZone !== view.reminder.timeZone))
  );
}

/** "6 pm", "12 am", "12 pm", "9 am". */
export function formatHour(h: number): string {
  const hour = ((h % 24) + 24) % 24;
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve} ${hour < 12 ? 'am' : 'pm'}`;
}

export function goalHeadline(view: Pick<GoalView, 'videosPerWeek' | 'postedThisWeek'>): string {
  if (view.videosPerWeek === 0) return 'No weekly goal';
  return `${view.postedThisWeek} of ${view.videosPerWeek} ${view.videosPerWeek === 1 ? 'video' : 'videos'} posted`;
}

export function streakLine(weeks: number): string {
  if (weeks <= 0) return 'No streak yet';
  return `${weeks} ${weeks === 1 ? 'week' : 'weeks'} in a row`;
}

/** "Goal off", "5 a week · reminder 6 pm", "5 a week". */
export function goalSummary(view: GoalView): string {
  if (view.videosPerWeek === 0) return 'Goal off';
  const head = `${view.videosPerWeek} a week`;
  return view.reminder.enabled ? `${head} · reminder ${formatHour(view.reminder.hour)}` : head;
}

/** The device's IANA time zone. */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
