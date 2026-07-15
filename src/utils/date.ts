/**
 * Calendar-date helpers anchored to IST (UTC+5:30).
 *
 * A scheduled departure is a *civil date* (a day on the calendar) plus a slot,
 * NOT an instant in time. The bug we keep hitting is deriving that civil date
 * via `Date.toISOString()` — which is UTC — so IST midnight rolls back to the
 * previous day (e.g. "today" in IST becomes yesterday's date string). Because
 * UKCAAR operates in India, every civil date in the system is an IST date.
 *
 * RULE: never use `toISOString().slice(0,10)` to get a calendar date. Use these.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** `YYYY-MM-DD` for the given instant in IST (defaults to now). Server-TZ-safe. */
export function istDateStr(d: Date = new Date()): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Minutes since IST midnight for the given instant (defaults to now). */
export function istMinutesOfDay(d: Date = new Date()): number {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

/** `YYYY-MM-DD` for `days` from the given instant, in IST. */
export function istDateStrPlusDays(days: number, d: Date = new Date()): string {
  return istDateStr(new Date(d.getTime() + days * 24 * 60 * 60 * 1000));
}

/** Day of week (0=Sun … 6=Sat) for the given instant, evaluated in IST.
 *  Use instead of `Date.getDay()` (server-local) when matching against a
 *  route's `daysOfWeek`, which is an IST-calendar concept. */
export function istWeekday(d: Date = new Date()): number {
  return new Date(d.getTime() + IST_OFFSET_MS).getUTCDay();
}
