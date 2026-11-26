/**
 * Weekly goal arithmetic. Weeks start on Monday in the user's reminder time zone.
 * Everything works on local calendar dates (YYYY-MM-DD), so daylight-saving
 * changes cannot shift a post into the wrong week.
 */

export interface LocalTime {
  /** YYYY-MM-DD */
  date: string;
  hour: number;
  /** 0 = Monday … 6 = Sunday */
  weekday: number;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

export function localTime(at: Date, timeZone: string): LocalTime {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, fmt);
  }
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date, hour: Number(parts.hour) % 24, weekday: weekdayOf(date) };
}

function utcOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

export function addDays(date: string, days: number): string {
  return new Date(utcOf(date) + days * 86_400_000).toISOString().slice(0, 10);
}

/** 0 = Monday … 6 = Sunday */
export function weekdayOf(date: string): number {
  return (new Date(utcOf(date)).getUTCDay() + 6) % 7;
}

/** The Monday of the week containing `date`. */
export function weekStartOf(date: string): string {
  return addDays(date, -weekdayOf(date));
}

export interface GoalStats {
  weekStart: string;
  postedThisWeek: number;
  streakWeeks: number;
}

/**
 * `posts` are (video id, time) pairs. A video counts once per week however many
 * platforms it went to. The streak counts consecutive completed weeks, ending
 * with last week, in which at least `videosPerWeek` videos were posted.
 */
export function goalStats(
  posts: readonly { videoId: string | null; postedAt: Date }[],
  videosPerWeek: number,
  timeZone: string,
  now: Date,
): GoalStats {
  const weekStart = weekStartOf(localTime(now, timeZone).date);
  const perWeek = new Map<string, Set<string>>();
  posts.forEach((p, i) => {
    const week = weekStartOf(localTime(p.postedAt, timeZone).date);
    const set = perWeek.get(week) ?? new Set<string>();
    set.add(p.videoId ?? `deleted-${i}`);
    perWeek.set(week, set);
  });
  const postedThisWeek = perWeek.get(weekStart)?.size ?? 0;
  let streakWeeks = 0;
  if (videosPerWeek > 0) {
    let week = addDays(weekStart, -7);
    while ((perWeek.get(week)?.size ?? 0) >= videosPerWeek) {
      streakWeeks += 1;
      week = addDays(week, -7);
    }
  }
  return { weekStart, postedThisWeek, streakWeeks };
}

/**
 * Behind pace means fewer posts than the goal pro-rated to the end of today:
 * with 3 a week, one is due by Monday night, two by Wednesday night, three by Sunday.
 */
export function isBehindPace(postedThisWeek: number, videosPerWeek: number, weekday: number): boolean {
  if (videosPerWeek <= 0 || postedThisWeek >= videosPerWeek) return false;
  const dueByTonight = Math.ceil((videosPerWeek * (weekday + 1)) / 7);
  return postedThisWeek < dueByTonight;
}
