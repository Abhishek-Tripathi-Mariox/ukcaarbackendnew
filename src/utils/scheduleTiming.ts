/**
 * Resolved timing rules for a scheduled (shuttle) route.
 *
 * Every knob is optional on `Route.schedule` — absent means "use the platform
 * default" below. Resolve through this helper instead of reading the schedule
 * fields directly so old route documents (saved before these fields existed)
 * behave identically to a route where the admin never touched the inputs.
 */
import type { IRouteSchedule } from '../models/Route';

export interface ResolvedScheduleTiming {
  /** Customer bookings close this many minutes before departure. */
  bookingCutoffMinutes: number;
  /** Customers may book at most this many days ahead (today = day 0). */
  maxAdvanceBookingDays: number;
  /** Driver may start the journey this many minutes before departure. */
  startWindowMinutes: number;
  /** Rest a driver must take after completing a trip on this route. */
  minRestMinutes: number;
  /** Free cancellation closes this many minutes before departure. */
  cancellationCutoffMinutes: number;
}

export const SCHEDULE_TIMING_DEFAULTS: ResolvedScheduleTiming = {
  bookingCutoffMinutes: 10,
  maxAdvanceBookingDays: 14,
  startWindowMinutes: 30,
  minRestMinutes: 0,
  cancellationCutoffMinutes: 60,
};

function pick(v: number | undefined | null, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}

export function getScheduleTiming(
  schedule?: Partial<IRouteSchedule> | null,
): ResolvedScheduleTiming {
  const d = SCHEDULE_TIMING_DEFAULTS;
  return {
    bookingCutoffMinutes: pick(schedule?.bookingCutoffMinutes, d.bookingCutoffMinutes),
    maxAdvanceBookingDays: pick(schedule?.maxAdvanceBookingDays, d.maxAdvanceBookingDays),
    startWindowMinutes: pick(schedule?.startWindowMinutes, d.startWindowMinutes),
    minRestMinutes: pick(schedule?.minRestMinutes, d.minRestMinutes),
    cancellationCutoffMinutes: pick(
      schedule?.cancellationCutoffMinutes,
      d.cancellationCutoffMinutes,
    ),
  };
}
