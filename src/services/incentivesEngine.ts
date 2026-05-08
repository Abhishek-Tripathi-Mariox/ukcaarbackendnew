import {
  DriverIncentive,
  DriverIncentiveProgress,
  IDriverIncentive,
  IncentivePeriod,
} from '../models/DriverIncentive';
import { IRide } from '../models/Ride';
import { User } from '../models';

/**
 * Compute period key + bounds for a given date.
 *  - daily   → YYYY-MM-DD, midnight..midnight UTC
 *  - weekly  → YYYY-Www (ISO week), Monday..Sunday UTC
 *  - monthly → YYYY-MM, first..last day UTC
 */
export function periodKeyFor(
  period: IncentivePeriod,
  date: Date = new Date()
): { key: string; start: Date; end: Date } {
  const d = new Date(date);
  if (period === 'daily') {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    const start = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate(), 0, 0, 0));
    const end = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
    return { key: `${y}-${m}-${day}`, start, end };
  }
  if (period === 'monthly') {
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const mm = String(m + 1).padStart(2, '0');
    const start = new Date(Date.UTC(y, m, 1, 0, 0, 0));
    const end = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999));
    return { key: `${y}-${mm}`, start, end };
  }
  // weekly (ISO week, Monday start)
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNr = (target.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  target.setUTCDate(target.getUTCDate() - dayNr + 3); // nearest Thursday
  const firstThursday = target.valueOf();
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const dayDiff = (firstThursday - yearStart.valueOf()) / 86400000;
  const weekNo = 1 + Math.round((dayDiff - ((yearStart.getUTCDay() + 6) % 7)) / 7);
  const year = target.getUTCFullYear();
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - dayNr);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  sunday.setUTCHours(23, 59, 59, 999);
  return { key: `${year}-W${String(weekNo).padStart(2, '0')}`, start: monday, end: sunday };
}

function computeReward(rule: IDriverIncentive, currentValue: number): number {
  if (rule.rewardType === 'flat') return rule.rewardAmount;
  // percentage: applied to currentValue (typically earnings)
  return Math.round((currentValue * rule.rewardAmount) / 100 * 100) / 100;
}

/**
 * Determine if the given ride matches the incentive's eligibility filters.
 */
function rideMatchesRule(rule: IDriverIncentive, ride: IRide, vehicleType?: string): boolean {
  if (rule.rideTypes && rule.rideTypes.length > 0 && !rule.rideTypes.includes(ride.rideType)) {
    return false;
  }
  if (rule.vehicleTypes && rule.vehicleTypes.length > 0 && vehicleType) {
    if (!rule.vehicleTypes.includes(vehicleType)) return false;
  }
  if (rule.driverIds && rule.driverIds.length > 0) {
    const drvId = String(ride.driver);
    if (!rule.driverIds.some((d) => String(d) === drvId)) return false;
  }
  return true;
}

/**
 * Process a completed ride against all active driver incentives.
 *
 * Idempotent-ish: increments use $inc + the recorded ride is implied by
 * the caller only invoking this once at completion time. Safe to call
 * even if no incentives are configured.
 */
export async function processRideForIncentives(ride: IRide): Promise<void> {
  if (!ride.driver || ride.status !== 'completed') return;

  const now = ride.completedAt ?? new Date();

  const rules = await DriverIncentive.find({
    active: true,
    $and: [
      { $or: [{ startDate: { $exists: false } }, { startDate: null }, { startDate: { $lte: now } }] },
      { $or: [{ endDate: { $exists: false } }, { endDate: null }, { endDate: { $gte: now } }] },
    ],
  });
  if (rules.length === 0) return;

  // Hydrate driver once for rating + vehicle filters
  const driver = await User.findById(ride.driver).select('driverProfile').lean();
  const dp: any = driver?.driverProfile ?? {};
  const driverRating: number = dp.rating ?? 0;
  const vehicleType: string | undefined = dp.vehicleType ?? dp.vehicleMake;

  for (const rule of rules) {
    if (rule.minRating && driverRating < rule.minRating) continue;
    if (!rideMatchesRule(rule, ride, vehicleType)) continue;

    const { key, start, end } = periodKeyFor(rule.period, now);

    // Atomically upsert progress
    const inc = {
      rideCount: 1,
      earnings: ride.driverEarnings || 0,
      progress: rule.target === 'rides' ? 1 : ride.driverEarnings || 0,
    };

    const doc = await DriverIncentiveProgress.findOneAndUpdate(
      { incentive: rule._id, driver: ride.driver, periodKey: key },
      {
        $setOnInsert: {
          incentive: rule._id,
          driver: ride.driver,
          periodKey: key,
          periodStart: start,
          periodEnd: end,
          target: rule.target,
          threshold: rule.threshold,
          rewardType: rule.rewardType,
          rewardAmountConfig: rule.rewardAmount,
        },
        $inc: inc,
      },
      { upsert: true, new: true }
    );

    // Threshold check (only flip from earned=false to true once)
    if (!doc.earned && doc.progress >= rule.threshold) {
      doc.earned = true;
      doc.earnedAt = new Date();
      const baseValue =
        rule.target === 'earnings' ? doc.earnings : doc.progress;
      doc.rewardAmount = computeReward(rule, baseValue);
      await doc.save();
    } else if (doc.earned && rule.rewardType === 'percentage') {
      // Percentage rewards keep growing with new rides
      const baseValue = rule.target === 'earnings' ? doc.earnings : doc.progress;
      doc.rewardAmount = computeReward(rule, baseValue);
      await doc.save();
    }
  }
}
