import { Request, Response } from 'express';
import { validationResult } from 'express-validator';
import { Ride, User, Wallet, Payment, PromoCode } from '../models';
import { config } from '../config';
import { getRideSettings } from '../utils/rideSettings';
import { AuthRequest } from '../middleware/auth';
import { processRideForIncentives } from '../services/incentivesEngine';
import {
  awardPointsForRide,
  resolveBookingLoyalty,
  loyaltyDiscountForAmount,
  consumeRedemption,
} from '../services/loyaltyEngine';
import { safeResolveSurge, isPickupBlocked } from '../services/surge';
import { emitToUser, emitToRide, notifyNearbyDrivers } from '../socket';
import { sendPushToUser } from './fcmController';
import { getRedis } from '../config/redis';

/**
 * Tracks which drivers received a ride:new-request for a given rideId, so
 * when one driver claims it we can broadcast `ride:request-taken` to the
 * losers and dismiss their pending modals. In-memory map; entries are
 * cleared on accept and auto-expire after 90s in case neither accept nor
 * reject ever fires (e.g. customer cancels mid-search).
 */
const DISPATCH_TTL_SEC = 90;
const dispatchKey = (rideId: string) => `dispatch:${rideId}`;

// In-memory fallback, used only when Redis is disabled/unavailable (i.e. a
// single backend instance). With multiple instances, the dispatch set MUST
// live in Redis: the instance that pages drivers (customer's request) is
// often NOT the instance that handles the accept (driver's request), so an
// in-process Map would be empty on the accepting instance and the losing
// drivers would never get their request modals dismissed.
const dispatchedDriversByRide = new Map<string, Set<string>>();

async function recordDispatch(rideId: string, driverIds: string[]): Promise<void> {
  if (driverIds.length === 0) return;
  const redis = await getRedis();
  if (redis) {
    const key = dispatchKey(rideId);
    await redis.sAdd(key, driverIds);
    await redis.expire(key, DISPATCH_TTL_SEC);
    return;
  }
  dispatchedDriversByRide.set(rideId, new Set(driverIds));
  setTimeout(() => dispatchedDriversByRide.delete(rideId), DISPATCH_TTL_SEC * 1000);
}

async function takeDispatchedDrivers(
  rideId: string,
  excludeId?: string,
): Promise<string[]> {
  const redis = await getRedis();
  if (redis) {
    const key = dispatchKey(rideId);
    const members = await redis.sMembers(key);
    await redis.del(key);
    return excludeId ? members.filter(id => id !== excludeId) : members;
  }
  const set = dispatchedDriversByRide.get(rideId);
  if (!set) return [];
  dispatchedDriversByRide.delete(rideId);
  const out = [...set];
  return excludeId ? out.filter(id => id !== excludeId) : out;
}

/**
 * Per-ride auto-cancel timers, keyed by ride ID. If no driver accepts a
 * fresh request within AUTO_CANCEL_MS, the timer flips the ride to
 * 'cancelled' (system) and notifies the customer so they can rebook.
 *
 * The timer is cleared in two places:
 *   - acceptRide: a driver picked it up; nothing to auto-cancel.
 *   - cancelRide: customer/admin cancelled manually; don't double-cancel.
 *
 * In-memory only. A process restart loses the timer — the ride sits in
 * 'searching' forever until the customer cancels. Acceptable given the
 * 5-minute window: a restart that long means bigger problems.
 */
const AUTO_CANCEL_MS = 5 * 60 * 1000;
const autoCancelTimers = new Map<string, NodeJS.Timeout>();

export function clearAutoCancel(rideId: string): void {
  const t = autoCancelTimers.get(rideId);
  if (t) {
    clearTimeout(t);
    autoCancelTimers.delete(rideId);
  }
}

function scheduleAutoCancel(rideId: string): void {
  clearAutoCancel(rideId);
  const t = setTimeout(async () => {
    autoCancelTimers.delete(rideId);
    try {
      const ride = await Ride.findById(rideId);
      // Only auto-cancel if the ride is still searching — if a driver has
      // since accepted (status flipped to driver_assigned) we leave it
      // alone. The accept handler should have cleared this timer anyway,
      // but the status guard is the source-of-truth.
      if (!ride || ride.status !== 'searching') return;
      ride.status = 'cancelled';
      ride.cancellation = {
        cancelledBy: 'system',
        reason: 'No driver accepted within 5 minutes',
        fee: 0,
        // Never dispatched, so never paid — nothing to refund.
        refundAmount: 0,
        cancelledAt: new Date(),
      };
      await ride.save();
      emitToUser(ride.customer.toString(), 'ride:cancelled', {
        rideId: String(ride._id),
        reason: 'No driver accepted within 5 minutes',
        cancelledBy: 'system',
        message: "Sorry, we couldn't find a driver in time. Please try again.",
      });
      // Dismiss any open ride-request modals on driver phones that were
      // pinged for this ride — they shouldn't be able to accept a ride
      // the customer no longer expects.
      const dispatched = await takeDispatchedDrivers(String(ride._id));
      await broadcastRequestTaken(String(ride._id), dispatched);
      console.log(`[auto-cancel] ride=${ride._id} cancelled (no driver in ${AUTO_CANCEL_MS / 1000}s)`);
    } catch (err) {
      console.error('[auto-cancel] failed:', err);
    }
  }, AUTO_CANCEL_MS);
  autoCancelTimers.set(rideId, t);
}

/**
 * Durable backstop for the in-memory auto-cancel timers above. A process
 * restart (deploy / nodemon reload) loses every pending setTimeout, leaving
 * those rides stuck in 'searching' forever — which then also blocks the
 * customer's next booking (one-active-ride guard). This sweep cancels any
 * 'searching' ride older than the timeout. Runs once at boot (to recover
 * rides orphaned by the previous restart) and then on an interval.
 */
export async function sweepStaleSearchingRides(): Promise<number> {
  const cutoff = new Date(Date.now() - AUTO_CANCEL_MS);
  const stale = await Ride.find({ status: 'searching', createdAt: { $lt: cutoff } }).select('_id customer');
  for (const ride of stale) {
    try {
      ride.status = 'cancelled';
      ride.cancellation = {
        cancelledBy: 'system',
        reason: 'No driver accepted within 5 minutes',
        fee: 0,
        // Never dispatched, so never paid — nothing to refund.
        refundAmount: 0,
        cancelledAt: new Date(),
      };
      await ride.save();
      clearAutoCancel(String(ride._id));
      emitToUser(ride.customer.toString(), 'ride:cancelled', {
        rideId: String(ride._id),
        reason: 'No driver accepted within 5 minutes',
        cancelledBy: 'system',
        message: "Sorry, we couldn't find a driver in time. Please try again.",
      });
      const dispatched = await takeDispatchedDrivers(String(ride._id));
      await broadcastRequestTaken(String(ride._id), dispatched);
    } catch (err) {
      console.error('[auto-cancel sweep] failed for ride', String(ride._id), err);
    }
  }
  if (stale.length) console.log(`[auto-cancel sweep] cancelled ${stale.length} stale searching ride(s)`);
  return stale.length;
}

let rideSweepTimer: NodeJS.Timeout | null = null;
/** Start the periodic stale-ride sweep. Call once after the DB connects. */
export function startRideMaintenance(): void {
  if (rideSweepTimer) return;
  sweepStaleSearchingRides().catch((e) => console.error('[auto-cancel sweep] boot run failed:', e));
  rideSweepTimer = setInterval(() => {
    sweepStaleSearchingRides().catch((e) => console.error('[auto-cancel sweep] failed:', e));
  }, 60 * 1000);
  rideSweepTimer.unref?.();
}

/**
 * Tell every driver that was paged for a ride to dismiss their open
 * request modal — used when one driver claims, the customer cancels, or
 * the 5-minute auto-cancel sweeps the ride.
 *
 * Sends BOTH a socket emit (instant for connected apps) and a low-priority
 * data-only FCM push (so a backgrounded loser whose socket dropped during
 * dispatch still gets their ring stopped). Without the FCM fan-out, drivers
 * who were paged via push (but not via socket) keep ringing forever.
 */
async function broadcastRequestTaken(rideId: string, driverIds: string[]): Promise<void> {
  for (const driverId of driverIds) {
    emitToUser(driverId, 'ride:request-taken', { rideId });
  }
  await Promise.all(
    driverIds.map(driverId =>
      sendPushToUser(driverId, {
        // title/body are only shown if the device renders the data push
        // as a notification — which we explicitly don't, the background
        // handler short-circuits on kind === 'ride:request-taken'.
        title: 'Request taken',
        body: 'Another driver accepted this ride.',
        data: { kind: 'ride:request-taken', rideId },
        android: { priority: 'high' as const },
      }).catch(err =>
        console.warn('[request-taken] FCM to', driverId, 'failed:', err),
      ),
    ),
  );
}

/**
 * Fan out a new ride to nearby online drivers.
 *
 * Two delivery channels — both fire-and-forget:
 *   1. Socket emit  → instant alert if the driver app is open & connected.
 *   2. FCM push     → wakes a backgrounded app, plays the alert sound, and
 *                     carries enough payload for the app to open the
 *                     RideRequestModal cold-start.
 *
 * The push uses a `kind: 'ride:new-request'` data field so the driver app's
 * FCM handler can route it to the modal instead of just showing a toast.
 */
async function dispatchToNearbyDrivers(ride: any): Promise<void> {
  const pickup = { lat: ride.pickup.lat, lng: ride.pickup.lng };
  const populatedCustomer = await User.findById(ride.customer).select(
    'firstName lastName',
  );
  const customerName =
    [populatedCustomer?.firstName, populatedCustomer?.lastName]
      .filter(Boolean)
      .join(' ') || 'Passenger';

  // Resolve the requested ride's tier (instant / private) from the admin-
  // managed VehicleType catalogue. The customer's `rideType` is now the
  // VehicleType.code, so we look it up rather than relying on `isPrivate`.
  // Falls back to 'instant' if the code is unknown — better to overserve
  // than to drop the request.
  const { VehicleType } = await import('../models');
  const requestedType = ride.rideType
    ? await VehicleType.findOne({ code: String(ride.rideType).toLowerCase() }).select(
        'code tier',
      )
    : null;
  const expectedTier =
    requestedType?.tier ?? (ride.isPrivate ? 'private' : 'instant');

  // Find online drivers registered for the requested vehicle type, then
  // distance-filter in memory. We can't use $nearSphere because the
  // currentLocation field is stored as a flat { lat, lng } subdoc rather
  // than a GeoJSON Point — and `isAvailable` isn't on the schema, so we
  // derive availability by excluding anyone with an in-flight ride.
  //
  // Tier (serviceType) is the primary partition: an 'instant' ride should
  // never page a 'scheduled' driver, regardless of vehicleTypeCode. We
  // additionally narrow by vehicleTypeCode if the customer's requested
  // type resolves to a known catalogue entry — but only as an OR with
  // "driver hasn't set a vehicleTypeCode yet". Without that allowance,
  // drivers who registered before vehicleTypeCode was required got
  // silently excluded from every dispatch (root cause of "bell never
  // rings for instant bookings" reports).
  const baseFilter: any = {
    role: 'driver',
    isActive: true,
    'driverProfile.isOnline': true,
  };
  const and: any[] = [];
  // serviceType partition. A driver with NO serviceType set (legacy account,
  // or one that skipped the step) is treated as 'instant' so they still get
  // instant dispatches instead of being silently excluded from everything —
  // same class of fix as the vehicleTypeCode allowance below. They never match
  // the premium 'private' tier, and 'scheduled' drivers still never match.
  if (expectedTier === 'instant') {
    and.push({
      $or: [
        { 'driverProfile.serviceType': 'instant' },
        { 'driverProfile.serviceType': { $exists: false } },
        { 'driverProfile.serviceType': null },
        { 'driverProfile.serviceType': '' },
      ],
    });
  } else {
    and.push({ 'driverProfile.serviceType': expectedTier });
  }
  if (requestedType?.code) {
    and.push({
      $or: [
        { 'driverProfile.vehicleTypeCode': requestedType.code },
        { 'driverProfile.vehicleTypeCode': { $exists: false } },
        { 'driverProfile.vehicleTypeCode': null },
        { 'driverProfile.vehicleTypeCode': '' },
      ],
    });
  }
  if (and.length) baseFilter.$and = and;
  const candidates = await User.find(baseFilter).select(
    '_id driverProfile.currentLocation',
  );

  // Drivers currently on a ride should not get new requests. Pull a list of
  // ones with an active assignment in one query and subtract.
  const busyIds = new Set(
    (
      await Ride.find({
        driver: { $in: candidates.map(c => c._id) },
        status: {
          $in: [
            'driver_assigned',
            'driver_arriving',
            'driver_arrived',
            'in_progress',
          ],
        },
      }).select('driver')
    ).map(r => String(r.driver)),
  );

  const RADIUS_KM = 7;
  const KM_PER_DEG_LAT = 111;
  const kmPerDegLng =
    111 * Math.cos((pickup.lat * Math.PI) / 180) || 111;
  // Bucket counts so a "bell didn't ring" complaint can be diagnosed from
  // logs alone (no need to add fresh logging each time).
  let droppedBusy = 0;
  let droppedNoLocation = 0;
  let droppedOutOfRange = 0;
  const nearbyDrivers = candidates
    .filter(d => {
      if (busyIds.has(String(d._id))) {
        droppedBusy++;
        return false;
      }
      return true;
    })
    .filter(d => {
      if (!d.driverProfile?.currentLocation) {
        droppedNoLocation++;
        return false;
      }
      return true;
    })
    .map(d => {
      const loc = d.driverProfile!.currentLocation!;
      const dLatKm = (loc.lat - pickup.lat) * KM_PER_DEG_LAT;
      const dLngKm = (loc.lng - pickup.lng) * kmPerDegLng;
      const distKm = Math.sqrt(dLatKm * dLatKm + dLngKm * dLngKm);
      return { _id: d._id, distKm };
    })
    .filter(x => {
      if (x.distKm > RADIUS_KM) {
        droppedOutOfRange++;
        return false;
      }
      return true;
    })
    .sort((a, b) => a.distKm - b.distKm)
    .slice(0, 20);

  console.log(
    `[ride-dispatch] ride=${ride._id} type=${requestedType?.code ?? '?'} tier=${expectedTier} ` +
    `pickup=${pickup.lat.toFixed(4)},${pickup.lng.toFixed(4)} ` +
    `candidates=${candidates.length} dropped(busy=${droppedBusy},no-loc=${droppedNoLocation},out-of-range=${droppedOutOfRange}) ` +
    `dispatched=${nearbyDrivers.length}`,
  );

  const ridePayload = {
    rideId: String(ride._id),
    variant: expectedTier,
    passengerName: customerName,
    pickup: ride.pickup.address,
    drop: ride.dropoff.address,
    pickupLat: ride.pickup.lat,
    pickupLng: ride.pickup.lng,
    dropLat: ride.dropoff.lat,
    dropLng: ride.dropoff.lng,
    fare: ride.estimatedFare,
    distance: ride.estimatedDistance,
    duration: ride.estimatedDuration,
  };

  // Remember who got pinged so the accept handler can dismiss the losers.
  await recordDispatch(
    String(ride._id),
    nearbyDrivers.map(d => String(d._id)),
  );

  // Socket: instant — for online drivers with an active connection.
  for (const driver of nearbyDrivers) {
    emitToUser(driver._id.toString(), 'ride:new-request', ridePayload);
  }

  // FCM: every nearby driver, in parallel. Failures per-driver are logged
  // by sendPushToUser and don't abort the rest of the fan-out.
  await Promise.all(
    nearbyDrivers.map(driver =>
      sendPushToUser(driver._id.toString(), {
        title: `New ${expectedTier} ride request`,
        body: `${customerName} · ${ride.pickup.address.slice(0, 40)} → ${ride.dropoff.address.slice(0, 40)}`,
        data: {
          kind: 'ride:new-request',
          ...Object.fromEntries(
            Object.entries(ridePayload).map(([k, v]) => [k, String(v)]),
          ),
        },
        // High-priority Android channel that plays the ride alert sound.
        android: { channelId: 'ukcaar_ride_alerts', priority: 'high' as const },
      }).catch(err =>
        console.warn('[ride-dispatch] FCM to', String(driver._id), 'failed:', err),
      ),
    ),
  );
}

/**
 * Helper: Calculate fare
 *
 * `rideType` is now an admin-defined VehicleType.code which means we can
 * receive codes that don't exist in the static `baseFares` table. We
 * resolve them by exact match first, then fall back to 'economy' rates so
 * the booking doesn't crash when admin adds a new type. Long-term the
 * fare structure should move onto the VehicleType document itself.
 */
/**
 * Resolve the pricing rule for a ride type by code. Looks up the admin-
 * managed VehicleType doc first — so admins can edit fares without a
 * deploy — and falls back to the legacy `config.ride.baseFares` table for
 * codes that haven't been configured yet ('economy', 'comfort', etc.). If
 * neither has a match we return the economy bucket so booking never fails
 * on an unknown code.
 *
 * In-memory cache (10s TTL) keeps the per-request `/rides/estimate`
 * iteration from doing N DB hits when admins have lots of types.
 */
const rateCache = new Map<string, { rule: { base: number; perKm: number; perMin: number; min: number; pricingModel: 'per_km' | 'subscription'; flatFare: number }; at: number }>();
const RATE_TTL_MS = 10_000;

/**
 * Invalidate the in-memory rate cache. Call this from admin endpoints
 * that mutate VehicleType fare fields so the next estimate reflects the
 * change instantly instead of waiting up to 10s for the TTL to expire.
 */
export function clearRateCache(): void {
  rateCache.clear();
}

/**
 * Move a ride from `payment_pending` → `completed`, settling all the
 * financial records (commission, driver earnings, wallet credit, payment
 * rows) and updating driver stats. Idempotent: if the ride is already
 * `completed` it's a no-op so duplicate calls (e.g. Razorpay verify
 * racing the webhook) can't double-credit the driver.
 *
 * Pulled out of `updateRideStatus` so the payment controllers (wallet
 * pay-ride, Razorpay verify, cash-confirm) can drive the same transition
 * without going through the driver-facing status endpoint.
 *
 * Caller is responsible for emitting the `ride:status` socket event after
 * this returns (so app-specific data — wallet balance, etc. — can be
 * included in the payload).
 */
/**
 * Pay the REFERRER once the person they referred completes their FIRST ride.
 *
 * Previously nobody was ever paid for referring: applying a code credited only
 * the joiner, and the admin referrals report displayed "earnings" computed from
 * a hardcoded constant that never moved any money.
 *
 * Hardening (each guard closes a verified hole):
 *  - `ride.actualFare > 0`: a ₹0-fare settlement (or a farmed empty ride)
 *    minted the full reward. No real fare, no reward.
 *  - True FIRST-ride gate: the referee must have exactly ONE completed ride
 *    (the one settling now). Without it, any long-time rider could apply a
 *    code and mint the reward on their very next trip.
 *  - Suspended/deactivated referrers are not paid (isActive checked). The
 *    claim is left unset so the payout still fires if they're reinstated.
 *  - Rate is read BEFORE claiming, so a disabled program (rate 0) never burns
 *    the claim.
 *  - Atomic claim on `referralRewardedAt` (with the paid amount recorded in
 *    `referralRewardAmount` so reports sum real history, not counts × today's
 *    rate). If the wallet credit then fails, the claim is ROLLED BACK — it
 *    used to be burned first, silently losing the payout forever.
 *  - Works for referred DRIVERS too (call sites pass both parties): a
 *    referred driver's first completed trip pays their referrer.
 *
 * Never throws: a referral-reward failure must not break ride settlement.
 */
export async function payReferrerOnFirstRide(refereeId: any, ride?: any): Promise<void> {
  let claimedUserId: any = null;
  try {
    if (!refereeId) return;
    // No real fare, no reward — blocks ₹0-fare and farmed empty settlements.
    if (ride && !(Number(ride.actualFare) > 0)) return;

    const referee: any = await User.findById(refereeId)
      .select('referredBy referralRewardedAt firstName lastName')
      .lean();
    if (!referee?.referredBy || referee.referralRewardedAt) return;

    const referrer: any = await User.findById(referee.referredBy)
      .select('role referralCode isActive')
      .lean();
    if (!referrer) return;
    // A suspended/deleted referrer isn't paid; the claim stays unset so a
    // reinstated account still gets it on the referee's next completed ride.
    if (referrer.isActive === false) return;

    const { Settings } = await import('../models');
    const cfg: any = await Settings.findOne({ key: 'platform' })
      .select('referrerRewardCustomer referrerRewardDriver')
      .lean();
    const amount = Math.max(
      0,
      Number(
        referrer.role === 'driver'
          ? cfg?.referrerRewardDriver ?? 0
          : cfg?.referrerRewardCustomer ?? 0,
      ),
    );
    if (!(amount > 0)) return;

    // True first ride: exactly one completed ride (the one that just settled),
    // counting the referee as rider or driver.
    const completedCount = await Ride.countDocuments({
      $or: [{ customer: refereeId }, { driver: refereeId }],
      status: 'completed',
    });
    if (completedCount !== 1) return;

    // Atomic claim — only the first caller matches.
    const claimed = await User.findOneAndUpdate(
      {
        _id: refereeId,
        referredBy: { $ne: null },
        $or: [{ referralRewardedAt: null }, { referralRewardedAt: { $exists: false } }],
      },
      { $set: { referralRewardedAt: new Date(), referralRewardAmount: amount } },
      { new: true },
    );
    if (!claimed) return;
    claimedUserId = refereeId;

    await Wallet.findOneAndUpdate(
      { user: referrer._id },
      { $inc: { balance: amount } },
      { upsert: true, new: true },
    );
    await Payment.create({
      user: referrer._id,
      type: 'bonus',
      amount,
      method: 'wallet',
      status: 'completed',
      description: `Referral reward — ${
        [referee.firstName, referee.lastName].filter(Boolean).join(' ') || 'A rider'
      } completed their first ride`,
    });
  } catch (err) {
    console.error('payReferrerOnFirstRide error:', err);
    // Roll the claim back so a transient credit failure retries on the next
    // completed ride instead of silently losing the payout forever.
    if (claimedUserId) {
      try {
        await User.updateOne(
          { _id: claimedUserId },
          { $unset: { referralRewardedAt: 1, referralRewardAmount: 1 } },
        );
      } catch (rollbackErr) {
        console.error('payReferrerOnFirstRide rollback failed:', rollbackErr);
      }
    }
  }
}

export async function finalizeRideSettlement(
  rideId: string,
  paymentMethod: 'wallet' | 'card' | 'cash',
): Promise<any | null> {
  const { Ride } = await import('../models');
  const existing: any = await Ride.findById(rideId);
  if (!existing) return null;
  if (existing.status === 'completed') return existing; // already settled
  if (existing.status !== 'payment_pending') return existing;

  // Honor OnePass: a driver with an active OnePass subscription pays the
  // reduced commission rate. This was hardcoded false ("driver context not
  // available here"), so OnePass drivers were over-charged commission on
  // every ride even though they'd paid for the lower rate.
  let isOnePass = false;
  if (existing.driver) {
    const drv = await User.findById(existing.driver).select(
      'driverProfile.isOnePass driverProfile.onePassExpiry',
    );
    const dp: any = (drv as any)?.driverProfile;
    isOnePass =
      !!dp?.isOnePass && !!dp?.onePassExpiry && new Date(dp.onePassExpiry) > new Date();
  }
  const rideSettings = await getRideSettings();
  const commissionRate = isOnePass
    ? rideSettings.onePassCommissionRate
    : rideSettings.commissionRate;
  const commission = Math.round((existing.actualFare ?? 0) * commissionRate * 100) / 100;
  const driverEarnings =
    Math.round(((existing.actualFare ?? 0) - commission + (existing.tip ?? 0)) * 100) / 100;

  // Atomic settlement claim: only the first caller flips payment_pending →
  // completed. The Razorpay webhook and the client's verify-payment call land
  // milliseconds apart and previously both read `payment_pending` and both ran
  // the driver wallet credit + stat increments (double settlement). The
  // conditional filter makes the loser find no matching document.
  const ride: any = await Ride.findOneAndUpdate(
    { _id: rideId, status: 'payment_pending' },
    {
      $set: {
        status: 'completed',
        paymentStatus: 'completed',
        paymentMethod,
        commission,
        driverEarnings,
      },
    },
    { new: true },
  );
  if (!ride) {
    // Lost the race — another path already settled this ride. Return the
    // now-current document without re-running any side effects.
    return await Ride.findById(rideId);
  }

  // ── Side effects below run exactly once (guarded by the atomic claim) ──

  // Referral reward: this may be either party's FIRST completed ride, which
  // is what actually earns their referrer the payout. Fire-and-forget — it
  // swallows its own errors so it can never fail a settled ride.
  await payReferrerOnFirstRide(ride.customer, ride);
  if (ride.driver) await payReferrerOnFirstRide(ride.driver, ride);

  // Driver stats
  if (ride.driver) {
    await User.findByIdAndUpdate(ride.driver, {
      $inc: {
        'driverProfile.totalTrips': 1,
        'driverProfile.totalEarnings': ride.driverEarnings,
      },
    });
  }

  // Customer-side payment row. The wallet-debit endpoint already writes
  // its own customer-side Payment record before calling this; in that
  // case we'd be double-writing. Skip when method='wallet' for that
  // exact reason — the wallet endpoint owns the customer-side record.
  if (paymentMethod !== 'wallet') {
    await Payment.create({
      user: ride.customer,
      ride: ride._id,
      type: 'ride_payment',
      amount: ride.actualFare,
      method: paymentMethod,
      status: 'completed',
      description: `Ride payment - ${ride.rideType}`,
    });
  }

  // Driver-side: credit wallet + statement row.
  if (ride.driver && ride.driverEarnings > 0) {
    await Wallet.findOneAndUpdate(
      { user: ride.driver },
      { $inc: { balance: ride.driverEarnings } },
      { upsert: true, new: true },
    );
    await Payment.create({
      user: ride.driver,
      ride: ride._id,
      type: 'ride_payment',
      amount: ride.driverEarnings,
      method: 'wallet',
      status: 'completed',
      description: `Ride earning - ${ride.rideType} (after ${Math.round(commissionRate * 100)}% commission)`,
    });
    if (ride.commission > 0) {
      await Payment.create({
        user: ride.driver,
        ride: ride._id,
        type: 'commission',
        amount: ride.commission,
        method: 'wallet',
        status: 'completed',
        description: `Platform commission (${Math.round(commissionRate * 100)}%)`,
      });
    }
  }

  // (No ride.save() — the atomic findOneAndUpdate above already persisted the
  // settlement fields; the side effects only touch other documents.)

  // Loyalty / incentives run lazy so they can't block the response.
  processRideForIncentives(ride).catch((err) =>
    console.error('[incentives] processRideForIncentives failed:', err),
  );
  awardPointsForRide(ride).catch((err) =>
    console.error('[loyalty] awardPointsForRide failed:', err),
  );

  return ride;
}

async function resolveRideRate(rideType: string): Promise<{
  base: number; perKm: number; perMin: number; min: number;
  pricingModel: 'per_km' | 'subscription'; flatFare: number;
}> {
  const key = String(rideType || '').toLowerCase();
  const cached = rateCache.get(key);
  if (cached && Date.now() - cached.at < RATE_TTL_MS) return cached.rule;

  // Admin doc takes priority. We only treat a field as configured when it's
  // a finite number — leaving any single field blank lets that bucket fall
  // back to the legacy default for partial migrations.
  const { VehicleType } = await import('../models');
  const doc = await VehicleType.findOne({ code: key }).select(
    'baseFare perKmFare perMinFare minFare pricingModel flatFare',
  );
  const legacy = (config.ride.baseFares as Record<string, { base: number; perKm: number; perMin: number }>);
  const fallback = legacy[key] ?? legacy.economy;
  const rule = {
    base: Number.isFinite(doc?.baseFare) ? (doc!.baseFare as number) : fallback.base,
    perKm: Number.isFinite(doc?.perKmFare) ? (doc!.perKmFare as number) : fallback.perKm,
    perMin: Number.isFinite(doc?.perMinFare) ? (doc!.perMinFare as number) : fallback.perMin,
    min: Number.isFinite(doc?.minFare) ? (doc!.minFare as number) : (config.ride.minFare ?? fallback.base),
    pricingModel: (doc?.pricingModel === 'subscription' ? 'subscription' : 'per_km') as
      | 'per_km'
      | 'subscription',
    flatFare: Number.isFinite(doc?.flatFare) ? (doc!.flatFare as number) : 0,
  };
  rateCache.set(key, { rule, at: Date.now() });
  return rule;
}

async function calculateFare(
  rideType: string,
  distanceKm: number,
  durationMin: number,
  promoDiscount: number = 0
) {
  const fare = await resolveRideRate(rideType);

  // Subscription vehicles (two/three-wheelers) charge a flat fare per ride —
  // no distance/time component, and surge is suppressed by the callers. The
  // flat amount is treated as the "base" so downstream breakdowns (which sum
  // base+distance+time) still total correctly.
  if (fare.pricingModel === 'subscription') {
    const flat = fare.flatFare;
    const discount = Math.min(promoDiscount, flat * 0.5);
    const total = Math.max(flat - discount, 0);
    return {
      baseFare: Math.round(flat * 100) / 100,
      distanceFare: 0,
      timeFare: 0,
      discount: Math.round(discount * 100) / 100,
      perKmFare: 0,
      perMinFare: 0,
      minFare: Math.round(flat * 100) / 100,
      total: Math.round(total * 100) / 100,
      pricingModel: 'subscription' as const,
    };
  }

  const baseFare = fare.base;
  const distanceFare = fare.perKm * distanceKm;
  const timeFare = fare.perMin * durationMin;
  const subtotal = baseFare + distanceFare + timeFare;
  const discount = Math.min(promoDiscount, subtotal * 0.5); // Max 50% discount
  const total = Math.max(subtotal - discount, fare.min);
  return {
    baseFare: Math.round(baseFare * 100) / 100,
    distanceFare: Math.round(distanceFare * 100) / 100,
    timeFare: Math.round(timeFare * 100) / 100,
    discount: Math.round(discount * 100) / 100,
    perKmFare: Math.round(fare.perKm * 100) / 100,
    perMinFare: Math.round(fare.perMin * 100) / 100,
    minFare: Math.round(fare.min * 100) / 100,
    total: Math.round(total * 100) / 100,
    pricingModel: 'per_km' as const,
  };
}

/**
 * POST /api/v1/rides/estimate
 * Get fare estimate for a ride
 */
export const estimateFare = async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      pickup,
      dropoff,
      rideType = 'economy',
      // Optional caller-supplied distance (km) and duration (minutes) from a
      // real routing engine (Google/OSRM, via /geo/directions). When the
      // caller has them, we use them verbatim so the fare matches the route
      // the user sees on the map — otherwise we fall back to a straight-
      // line Haversine + a 3-min/km rule of thumb (which doesn't account
      // for road network or traffic and is what was producing the 164-min
      // estimate vs the 99-min routed time the map was showing).
      distance: distanceOverride,
      duration: durationOverride,
    } = req.body;

    if (!pickup?.lat || !pickup?.lng || !dropoff?.lat || !dropoff?.lng) {
      res.status(400).json({ success: false, message: 'Pickup and dropoff coordinates required' });
      return;
    }

    const toNum = (v: any): number | null => {
      if (v === undefined || v === null || v === '') return null;
      const n = typeof v === 'number' ? v : parseFloat(String(v));
      return Number.isFinite(n) && n >= 0 ? n : null;
    };
    const overrideDistance = toNum(distanceOverride);
    const overrideDuration = toNum(durationOverride);

    let distance: number;
    let duration: number;
    if (overrideDistance !== null && overrideDuration !== null) {
      distance = overrideDistance;
      duration = overrideDuration;
    } else {
      // Calculate distance (Haversine formula)
      const R = 6371; // km
      const dLat = ((dropoff.lat - pickup.lat) * Math.PI) / 180;
      const dLng = ((dropoff.lng - pickup.lng) * Math.PI) / 180;
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((pickup.lat * Math.PI) / 180) *
          Math.cos((dropoff.lat * Math.PI) / 180) *
          Math.sin(dLng / 2) ** 2;
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      distance = overrideDistance ?? R * c;
      duration = overrideDuration ?? distance * 3; // rough fallback: 3 min/km
    }

    // Build the list of types to price. We union admin-managed active
    // VehicleType codes (so a freshly-added "MUV" gets a fare estimate
    // immediately) with the legacy buckets (so old client code paths
    // referencing 'economy'/'comfort'/etc. still resolve).
    const { VehicleType } = await import('../models');
    const adminTypes = await VehicleType.find({ isActive: true })
      .sort({ sortOrder: 1, name: 1 })
      .select('code name');
    const legacyCodes = Object.keys(config.ride.baseFares);
    const seen = new Set<string>();
    const rideTypes: Array<{ code: string; name?: string }> = [];
    for (const t of adminTypes) {
      const c = String(t.code).toLowerCase();
      if (seen.has(c)) continue;
      seen.add(c);
      rideTypes.push({ code: c, name: t.name });
    }
    for (const c of legacyCodes) {
      if (seen.has(c)) continue;
      seen.add(c);
      rideTypes.push({ code: c });
    }

    // Resolve surge once for the pickup point — same surge applied to every variant.
    const baselineSubtotal = (config.ride.baseFares.economy.base) +
      (config.ride.baseFares.economy.perKm * distance) +
      (config.ride.baseFares.economy.perMin * duration);
    const surge = await safeResolveSurge(pickup.lat, pickup.lng, baselineSubtotal);

    // Resolve loyalty once (tier % + the voucher that would auto-apply). The
    // optional `loyaltyCode` lets the app preview a specific voucher. This is
    // a preview only — nothing is consumed here.
    const loyalty = await resolveBookingLoyalty(
      (req as AuthRequest).user!._id,
      (req.body?.loyaltyCode as string) || undefined
    );

    const estimates = await Promise.all(
      rideTypes.map(async ({ code, name }) => {
        const fare = await calculateFare(code, distance, duration);
        const subtotal = fare.baseFare + fare.distanceFare + fare.timeFare;
        // Flat-fare (subscription) vehicles ignore surge — the price is fixed.
        const surgeAmount =
          fare.pricingModel === 'subscription'
            ? 0
            : Math.round((subtotal * (surge.multiplier - 1) + surge.flatSurcharge) * 100) / 100;
        const preLoyalty = Math.round((fare.total + surgeAmount) * 100) / 100;
        const loyaltyDiscount = loyaltyDiscountForAmount(loyalty, preLoyalty);
        const total = Math.round(Math.max(0, preLoyalty - loyaltyDiscount) * 100) / 100;
        return {
          rideType: code,
          rideTypeName: name,
          estimatedFare: total,
          loyaltyDiscount,
          baseFare: fare.baseFare,
          distanceFare: fare.distanceFare,
          timeFare: fare.timeFare,
          // Per-unit rates so the customer app can show the rider how
          // the total was built ("₹X base + ₹Y/km × distance + ₹Z/min ×
          // duration") instead of one opaque number.
          perKmFare: fare.perKmFare,
          perMinFare: fare.perMinFare,
          minFare: fare.minFare,
          surgeFare: surgeAmount,
          surgeMultiplier: surge.multiplier,
          estimatedDistance: Math.round(distance * 10) / 10,
          estimatedDuration: Math.round(duration),
        };
      }),
    );

    res.status(200).json({
      success: true,
      data: {
        estimates,
        distance: Math.round(distance * 10) / 10,
        duration: Math.round(duration),
        surge: {
          multiplier: surge.multiplier,
          flatSurcharge: surge.flatSurcharge,
          reasons: surge.reasons,
        },
        loyalty: {
          tierPct: loyalty.tierPct,
          voucher: loyalty.voucher
            ? { code: loyalty.voucher.code, type: loyalty.voucher.type, value: loyalty.voucher.value }
            : null,
        },
      },
    });
  } catch (error) {
    console.error('estimateFare error:', error);
    res.status(500).json({ success: false, message: 'Fare estimation failed' });
  }
};

/**
 * POST /api/v1/rides
 * Create a new ride request
 */
export const createRide = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, errors: errors.array() });
      return;
    }

    const {
      rideType, pickup, dropoff, stops, paymentMethod,
      promoCode, loyaltyCode, isScheduled, scheduledAt, isPrivate,
      distance: distanceOverride, duration: durationOverride,
    } = req.body;

    // Distance/duration: prefer the real-route values the client already
    // resolved via /geo/directions (Google/OSRM road distance) so the
    // persisted ride matches the quote the rider saw on SelectRide. Only fall
    // back to straight-line Haversine when the client didn't send them (older
    // app build, or directions failed). This mirrors `estimateFare` above —
    // previously createRide ALWAYS recomputed Haversine and silently discarded
    // the routed distance, so the booked fare/distance disagreed with the quote
    // whenever Google/OSRM were reachable.
    const toNum = (v: unknown): number | null => {
      const n = typeof v === 'number' ? v : parseFloat(String(v));
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const overrideDistance = toNum(distanceOverride);
    const overrideDuration = toNum(durationOverride);

    let distance: number;
    let duration: number;
    if (overrideDistance !== null && overrideDuration !== null) {
      distance = overrideDistance;
      duration = overrideDuration;
    } else {
      // Straight-line Haversine fallback (rough 3 min/km for duration).
      const R = 6371;
      const dLat = ((dropoff.lat - pickup.lat) * Math.PI) / 180;
      const dLng = ((dropoff.lng - pickup.lng) * Math.PI) / 180;
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((pickup.lat * Math.PI) / 180) *
          Math.cos((dropoff.lat * Math.PI) / 180) *
          Math.sin(dLng / 2) ** 2;
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      distance = overrideDistance ?? R * c;
      duration = overrideDuration ?? distance * 3;
    }

    // Apply promo
    let promoDiscount = 0;
    if (promoCode) {
      const promo = await PromoCode.findOne({
        code: promoCode.toUpperCase(),
        isActive: true,
        expiresAt: { $gt: new Date() },
        $expr: { $lt: ['$usedCount', '$maxUses'] },
      });
      if (promo) {
        // Per-customer limit (maxUsesPerUser): count this customer's prior
        // rides that redeemed the code. Unset = unlimited.
        let userAllowed = true;
        if (promo.maxUsesPerUser && promo.maxUsesPerUser > 0) {
          const priorUses = await Ride.countDocuments({
            customer: req.user!._id,
            promoCode: promo.code,
            status: { $nin: ['cancelled'] },
          });
          userAllowed = priorUses < promo.maxUsesPerUser;
        }
        const fare = await calculateFare(rideType, distance, duration);
        if (userAllowed && fare.total >= promo.minFare) {
          // maxDiscount is a CAP only when set; absent means no cap. (It used
          // to default to 50, silently halving any larger promo.)
          const cap =
            promo.maxDiscount && promo.maxDiscount > 0 ? promo.maxDiscount : Infinity;
          promoDiscount =
            promo.type === 'percentage'
              ? Math.min((fare.total * Math.max(0, promo.value)) / 100, cap)
              : Math.min(Math.max(0, promo.value), cap);
          await PromoCode.findByIdAndUpdate(promo._id, { $inc: { usedCount: 1 } });
        }
      }
    }

    const fare = await calculateFare(rideType, distance, duration, promoDiscount);

    // Geofence: reject pickup in restricted / no-pickup zones
    const block = await isPickupBlocked(pickup.lat, pickup.lng);
    if (block.blocked) {
      res.status(400).json({
        success: false,
        message: `Pickups are not allowed in this area${
          block.zone ? ` (${block.zone.name})` : ''
        }.`,
      });
      return;
    }

    // Apply surge based on pickup location + scheduled time (or now)
    const subtotal = fare.baseFare + fare.distanceFare + fare.timeFare;
    const surgeWhen = isScheduled && scheduledAt ? new Date(scheduledAt) : new Date();
    const surge = await safeResolveSurge(pickup.lat, pickup.lng, subtotal, surgeWhen);
    // Flat-fare (subscription) vehicles ignore surge — the price is fixed.
    const surgeAmount = fare.pricingModel === 'subscription' ? 0 : surge.surgeAmount;
    const totalWithSurge = Math.round((fare.total + surgeAmount) * 100) / 100;

    // Loyalty: tier discount + redeemed voucher, applied on the post-surge
    // total. Auto-picks the customer's best applicable voucher unless a
    // specific `loyaltyCode` was passed. Consumed below, once the ride exists.
    const loyalty = await resolveBookingLoyalty(req.user!._id, loyaltyCode);
    const loyaltyDiscount = loyaltyDiscountForAmount(loyalty, totalWithSurge);
    const finalTotal = Math.round(Math.max(0, totalWithSurge - loyaltyDiscount) * 100) / 100;

    // 4-digit pickup OTP — random in [1000, 9999] so it never starts with 0
    // (avoids "0123" looking like a 3-digit code on the customer screen).
    const pickupOtp = String(Math.floor(1000 + Math.random() * 9000));

    // Scheduled-shuttle bookings reserve a seat on an admin-defined Route
    // — they don't dispatch to nearby drivers, and the rider doesn't see
    // a "finding driver" screen. We park them as `driver_assigned` so the
    // app's "active ride" lookup (which excludes `searching`-state
    // pending-dispatch rows) still sees them, and skip the dispatch +
    // auto-cancel kicks entirely. The Route's `registeredDrivers` list
    // already tells us who operates the shuttle on the day.
    const isScheduledBooking = !!isScheduled;

    // One active instant/private ride per customer — block a second request
    // while one is still live. Scheduled-shuttle bookings are exempt (a rider
    // can legitimately hold several seat reservations across dates).
    if (!isScheduledBooking) {
      const existingActive = await Ride.findOne({
        customer: req.user!._id,
        isScheduled: { $ne: true },
        status: {
          $in: ['searching', 'driver_assigned', 'driver_arriving', 'driver_arrived', 'in_progress'],
        },
      }).select('_id status');
      if (existingActive) {
        res.status(409).json({
          success: false,
          message: 'You already have an active ride. Finish or cancel it before booking another.',
          data: { activeRideId: String(existingActive._id) },
        });
        return;
      }
    }

    const ride = await Ride.create({
      customer: req.user!._id,
      rideType,
      pickup,
      dropoff,
      stops,
      estimatedDistance: Math.round(distance * 10) / 10,
      estimatedDuration: Math.round(duration),
      estimatedFare: finalTotal,
      baseFare: fare.baseFare,
      distanceFare: fare.distanceFare,
      timeFare: fare.timeFare,
      surgeFare: surgeAmount,
      // `discount` carries the full reduction (promo + loyalty) for receipts.
      discount: Math.round((fare.discount + loyaltyDiscount) * 100) / 100,
      loyaltyDiscount,
      loyaltyRedemption: loyalty.voucher?.redemptionId,
      paymentMethod: paymentMethod || 'card',
      promoCode,
      isScheduled: isScheduledBooking,
      scheduledAt,
      isPrivate: isPrivate || false,
      // Scheduled rides skip the `searching` phase — there's no
      // dispatch race to resolve. The driver is whichever driver is
      // approved on the matching Route at the scheduled time, picked up
      // by the Route's existing registration. Keeping it out of
      // `searching` also prevents the 5-min auto-cancel from sweeping
      // future-dated reservations.
      status: isScheduledBooking ? 'driver_assigned' : 'searching',
      pickupOtp,
    });

    // Consume the voucher now that we have a ride to attribute it to. The
    // tier discount needs no consumption (it's an always-on benefit).
    if (loyalty.voucher && loyaltyDiscount > 0) {
      await consumeRedemption(loyalty.voucher.redemptionId, ride._id);
    }

    if (!isScheduledBooking) {
      // Dispatch to nearby online drivers — real-time via socket, with FCM
      // as a fallback so backgrounded apps still get a high-priority push.
      // Both run async so a slow push provider can't block the API response.
      dispatchToNearbyDrivers(ride).catch(err =>
        console.error('[ride-dispatch] failed:', err)
      );

      // Auto-cancel after 5 minutes if no driver accepts.
      scheduleAutoCancel(String(ride._id));
    }

    res.status(201).json({
      success: true,
      message: isScheduledBooking ? 'Scheduled seat reserved' : 'Ride request created',
      data: { ride },
    });
  } catch (error) {
    console.error('createRide error:', error);
    res.status(500).json({ success: false, message: 'Failed to create ride' });
  }
};

/**
 * GET /api/v1/rides/:id
 */
export const getRide = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const ride = await Ride.findById(req.params.id)
      .populate('customer', 'firstName lastName phone avatar')
      .populate('driver', 'firstName lastName phone avatar driverProfile.rating driverProfile.vehicleMake driverProfile.vehicleModel driverProfile.vehicleColor driverProfile.plateNumber');

    if (!ride) {
      res.status(404).json({ success: false, message: 'Ride not found' });
      return;
    }

    // Ownership check (IDOR fix): only the ride's own customer/driver (or an
    // admin) may read it. This endpoint is polled every few seconds by both
    // apps, so it must allow both participants — but not arbitrary users, who
    // could otherwise enumerate ride ids to harvest phone numbers + the OTP.
    const uid = String(req.user!._id);
    const customerId = String((ride.customer as any)?._id ?? ride.customer);
    const driverId = ride.driver ? String((ride.driver as any)?._id ?? ride.driver) : null;
    const isAdmin = req.user!.role === 'admin';
    if (!isAdmin && uid !== customerId && uid !== driverId) {
      res.status(403).json({ success: false, message: 'Not your ride' });
      return;
    }

    // The pickup OTP is the customer's proof-of-identity to the driver — the
    // driver must ENTER it, never read it. Strip it for everyone but the
    // customer so the OTP verification can't be bypassed by a GET.
    const rideObj: any = ride.toObject();
    if (uid !== customerId) {
      delete rideObj.pickupOtp;
    }

    res.status(200).json({ success: true, data: { ride: rideObj } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch ride' });
  }
};

/**
 * GET /api/v1/rides/active
 *
 * Returns the caller's current in-flight ride, if any — used by both the
 * customer and driver apps on cold start to resume the right screen instead
 * of dropping the user on the home dashboard while a ride is mid-flow.
 *
 * Includes 'searching' so a customer who killed the app right after booking
 * still lands back on the FindingDriver screen.
 */
const ACTIVE_RIDE_STATUSES = [
  'searching',
  'driver_assigned',
  'driver_arriving',
  'driver_arrived',
  'in_progress',
  // payment_pending: the trip ended but isn't paid. Both apps need to resume
  // it on cold start — the customer to the pay screen, the driver to the cash
  // summary — otherwise a killed app stranded the (cash) settlement forever.
  'payment_pending',
] as const;

export const getActiveRide = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const filter: Record<string, any> = {
      status: { $in: ACTIVE_RIDE_STATUSES },
      // Exclude legacy point-to-point "scheduled" Ride docs. The real shuttle
      // flow uses ScheduledBooking; a Ride created with isScheduled:true has no
      // driver and can never progress, so without this it would latch as the
      // customer's "active ride" on every cold start and hijack app resume.
      isScheduled: { $ne: true },
    };
    if (req.user?.role === 'driver') {
      filter.driver = req.user._id;
    } else {
      filter.customer = req.user!._id;
    }

    const ride = await Ride.findOne(filter)
      .sort({ createdAt: -1 })
      .populate('customer', 'firstName lastName phone avatar')
      .populate(
        'driver',
        'firstName lastName phone avatar driverProfile.rating driverProfile.vehicleMake driverProfile.vehicleModel driverProfile.vehicleColor driverProfile.plateNumber driverProfile.totalTrips',
      );

    res.status(200).json({ success: true, data: { ride: ride ?? null } });
  } catch (error) {
    console.error('getActiveRide error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch active ride' });
  }
};

/**
 * GET /api/v1/rides
 * Get user ride history
 */
export const getRides = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip = (page - 1) * limit;

    const filter: Record<string, any> = {};
    if (req.user?.role !== 'admin' && req.user?._id) {
      if (req.user.role === 'driver' && req.query.asDriver === 'true') {
        filter.driver = req.user._id;
      } else {
        filter.$or = [{ customer: req.user._id }, { driver: req.user._id }];
      }
    }

    if (req.query.status) {
      filter.status = req.query.status;
    }

    // Scheduled-shuttle bookings (ScheduledBooking) need to appear on the
    // customer Activity → Scheduled tab. The tab already filters its
    // results by `isScheduled === true`, so we pull the user's bookings
    // here and project them to a Ride-shaped row with that flag set.
    // Only relevant for customers — drivers see their bookings via the
    // route registration UI in the driver app.
    // Only CUSTOMERS get scheduled-shuttle bookings merged into ride history.
    // Drivers previously got their shuttle bookings mixed in as `sched_<id>`
    // rows whose detail tap called getRide("sched_…") → 500. Drivers see their
    // journeys in the dedicated scheduled-journeys screen instead.
    const includeBookings = req.user?.role === 'customer';

    const bookingFilter: Record<string, any> = {};
    if (includeBookings && req.user?._id) {
      bookingFilter.$or = [{ customer: req.user._id }, { driver: req.user._id }];
      if (req.query.status === 'cancelled') {
        bookingFilter.status = 'cancelled';
      } else if (req.query.status === 'completed') {
        bookingFilter.status = 'completed';
      } else {
        bookingFilter.status = { $in: ['reserved', 'completed', 'cancelled'] };
      }
    }

    const { ScheduledBooking } = await import('../models');

    const [rides, rideTotal, bookings, bookingTotal] = await Promise.all([
      Ride.find(filter)
        .populate('customer', 'firstName lastName avatar')
        .populate('driver', 'firstName lastName avatar driverProfile.rating')
        .sort({ createdAt: -1 })
        .lean(),
      Ride.countDocuments(filter),
      includeBookings
        ? ScheduledBooking.find(bookingFilter)
            .populate({
              path: 'route',
              select: 'name stops schedule',
            })
            .populate(
              'driver',
              'firstName lastName avatar phone driverProfile.rating driverProfile.plateNumber ' +
                'driverProfile.vehicleMake driverProfile.vehicleModel driverProfile.vehicleColor',
            )
            .sort({ createdAt: -1 })
            .lean()
        : Promise.resolve([] as any[]),
      includeBookings ? ScheduledBooking.countDocuments(bookingFilter) : Promise.resolve(0),
    ]);

    // Which of the reserved bookings belong to a shuttle that's actually
    // running right now? Load the matching DriverJourney for each and treat
    // active/in_progress as "live". This is what lets an active scheduled ride
    // surface in the customer's Active tab and become trackable — a plain
    // `reserved` booking otherwise looks identical whether the bus left an hour
    // ago or departs next week.
    const { DriverJourney } = await import('../models');
    const journeyKeyOf = (routeId: any, idx: number, date: string) =>
      `${String(routeId)}_${idx}_${date}`;
    const reserved = (bookings as any[]).filter(
      (b) => b.status === 'reserved' && b.driver && b.route?._id,
    );
    const journeyStatusByKey = new Map<string, string>();
    if (reserved.length > 0) {
      const or = reserved.map((b) => ({
        route: b.route._id,
        driver: (b.driver as any)?._id ?? b.driver,
        departureIndex: b.departureIndex,
        departureDate: b.departureDate,
      }));
      const journeys = await DriverJourney.find({ $or: or })
        .select('route driver departureIndex departureDate status')
        .lean();
      for (const j of journeys) {
        journeyStatusByKey.set(
          journeyKeyOf(j.route, j.departureIndex, j.departureDate),
          j.status,
        );
      }
    }

    // Project each ScheduledBooking → the Ride shape the customer
    // RideHistoryScreen renders. `_id` is prefixed `sched_<id>` so the
    // FlatList key stays unique against real ride ids and the screen
    // can route booking taps to ScheduledBookingDetails instead of the
    // ride flow.
    const projected = (bookings as any[]).map((b: any) => {
      const stops = [...(b.route?.stops ?? [])].sort(
        (x: any, y: any) => (x.sequence ?? 0) - (y.sequence ?? 0),
      );
      const stopBySeq = (seq?: number) =>
        typeof seq === 'number' ? stops.find((s: any) => (s.sequence ?? 0) === seq) : undefined;
      // Prefer the rider's booked boarding/dropping stops; fall back to the
      // route's first/last stop for legacy bookings without a stored segment.
      const first = stopBySeq(b.boardingStopSequence) ?? stops[0];
      const last = stopBySeq(b.droppingStopSequence) ?? stops[stops.length - 1];
      const slot = b.route?.schedule?.departures?.[b.departureIndex];

      const drv: any = b.driver && (b.driver as any)._id ? b.driver : null;
      const dp = drv?.driverProfile ?? {};
      const jKey = b.route?._id
        ? journeyKeyOf(b.route._id, b.departureIndex, b.departureDate)
        : null;
      const jStatus = jKey ? journeyStatusByKey.get(jKey) : undefined;
      const hasBoarded = (b.boardedSeats?.length ?? 0) > 0;
      // Live iff still reserved AND (the driver's journey is running OR the
      // rider already boarded) AND they haven't already been dropped early. An
      // APPROVED early-drop means the rider has left the bus, so it stops being
      // "live"; a declined one keeps them on to their booked stop.
      const isActiveNow =
        b.status === 'reserved' &&
        b.earlyDrop?.status !== 'approved' &&
        (jStatus === 'active' || jStatus === 'in_progress' || hasBoarded);

      return {
        _id: `sched_${b._id}`,
        rideType: 'scheduled',
        isScheduled: true,
        isActiveNow,
        status:
          b.status === 'cancelled'
            ? 'cancelled'
            : b.status === 'completed'
              ? 'completed'
              : isActiveNow
                ? 'in_progress'
                : 'driver_assigned',
        pickup: first
          ? {
              address: first.name ?? first.address ?? 'Stop 1',
              lat: first.lat,
              lng: first.lng,
            }
          : { address: 'N/A', lat: 0, lng: 0 },
        dropoff: last
          ? {
              address: last.name ?? last.address ?? 'Last stop',
              lat: last.lat,
              lng: last.lng,
            }
          : { address: 'N/A', lat: 0, lng: 0 },
        estimatedFare: b.totalAmount,
        actualFare: b.totalAmount,
        baseFare: b.totalAmount,
        distanceFare: 0,
        timeFare: 0,
        discount: 0,
        estimatedDistance: 0,
        estimatedDuration: 0,
        paymentMethod: b.paymentMethod === 'wallet' ? 'wallet' : 'card',
        createdAt: b.createdAt,
        // Populated driver so the tracking card can show name/vehicle/rating
        // without a follow-up call (kept as the top-level `driver` for parity
        // with real rides, which RideHistory/RatingSheet already read).
        driver: drv
          ? {
              _id: String(drv._id),
              firstName: drv.firstName,
              lastName: drv.lastName,
              avatar: drv.avatar ?? null,
              driverProfile: { rating: dp.rating ?? null },
            }
          : null,
        // Booking-specific metadata so the Activity card / details / tracking
        // screen can render the right info without a follow-up call.
        booking: {
          id: String(b._id),
          route: b.route?._id ?? null,
          routeName: b.route?.name ?? null,
          departureDate: b.departureDate,
          departureIndex: b.departureIndex,
          departureTime: slot?.time ?? null,
          seats: b.seats ?? [],
          passengers: b.passengers ?? [],
          driver: (b.driver as any)?._id ? String((b.driver as any)._id) : (b.driver ?? null),
          driverName: drv
            ? [drv.firstName, drv.lastName].filter(Boolean).join(' ') || 'Driver'
            : null,
          driverPhone: drv?.phone ?? null,
          driverRating: dp.rating ?? null,
          vehicle: drv
            ? {
                make: dp.vehicleMake ?? '',
                model: dp.vehicleModel ?? '',
                color: dp.vehicleColor ?? '',
                plateNumber: dp.plateNumber ?? '',
              }
            : null,
          journeyKey: jKey,
          journeyStatus: jStatus ?? null,
          boardingStopSequence: b.boardingStopSequence ?? null,
          droppingStopSequence: b.droppingStopSequence ?? null,
          boardedSeats: b.boardedSeats ?? [],
          droppedSeats: b.droppedSeats ?? [],
          earlyDrop: b.earlyDrop ?? null,
          refundedAmount: b.refundedAmount ?? 0,
        },
      };
    });

    const combined = [...rides, ...projected].sort(
      (a: any, b: any) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    const total = rideTotal + bookingTotal;
    const paged = combined.slice(skip, skip + limit);

    res.status(200).json({
      success: true,
      data: {
        rides: paged,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    console.error('getRides error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch rides' });
  }
};

/**
 * PUT /api/v1/rides/:id/accept  (Driver)
 *
 * First-driver-wins: status only flips from 'searching' → 'driver_assigned',
 * so the second driver to tap accept gets a 400. We re-fetch the ride after
 * save with populated driver + vehicle so the customer can render the
 * "driver on the way" card without a follow-up GET.
 */
export const acceptRide = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    // Approval gate: only an admin-approved driver may accept a real ride.
    // `/drivers/registration/step` sets role:'driver' during signup (so a
    // brand-new account is a "driver" long before vetting), and nothing else
    // downstream re-checked approval — an unvetted account could go online and
    // accept live customer rides. Admin approval sets registrationStep:
    // 'approved' (adminDrivers.ts).
    const driverUser: any = req.user;
    if (driverUser?.role !== 'driver') {
      res.status(403).json({ success: false, message: 'Only drivers can accept rides' });
      return;
    }
    if (driverUser?.driverProfile?.registrationStep !== 'approved') {
      res.status(403).json({
        success: false,
        message: 'Your driver account is pending approval. You cannot accept rides yet.',
      });
      return;
    }

    // Atomic claim — prevents two drivers from both winning the same ride
    // when their taps overlap. findOneAndUpdate with the status guard
    // returns null for the loser.
    const claimed = await Ride.findOneAndUpdate(
      { _id: req.params.id, status: 'searching' },
      { $set: { driver: req.user!._id, status: 'driver_assigned' } },
      { new: true },
    );
    if (!claimed) {
      res.status(400).json({ success: false, message: 'Ride no longer available' });
      return;
    }

    // Driver locked the ride in time — cancel the 5-minute auto-cancel timer.
    clearAutoCancel(String(claimed._id));

    const ride = await Ride.findById(claimed._id)
      .populate('customer', 'firstName lastName phone avatar')
      .populate(
        'driver',
        'firstName lastName phone avatar driverProfile.rating driverProfile.vehicleMake driverProfile.vehicleModel driverProfile.vehicleColor driverProfile.plateNumber driverProfile.currentLocation',
      );

    // Tell the losing drivers their request modal is stale, so the app can
    // dismiss it instead of waiting for the 27s timer to expire. We also
    // resend through FCM is overkill — modal dismissal is a transient UI
    // concern, drivers without an open app will simply never see it.
    const losers = await takeDispatchedDrivers(
      String(claimed._id),
      String(req.user!._id),
    );
    await broadcastRequestTaken(String(claimed._id), losers);

    // The customer needs the OTP to display, but the driver must NOT see it
    // — the whole point is the driver asks the passenger and types it back.
    // We send the customer the full ride (with otp) on their socket, and
    // strip otp from the response the driver gets.
    emitToUser(String(claimed.customer), 'ride:driver-assigned', { ride });
    const driverFacingRide = ride
      ? { ...ride.toObject(), pickupOtp: undefined }
      : ride;
    // Push fallback in case the customer app is backgrounded.
    sendPushToUser(String(claimed.customer), {
      title: 'Driver on the way',
      body: `Your ride has been accepted. Tap to track.`,
      data: { kind: 'ride:driver-assigned', rideId: String(claimed._id) },
    }).catch(err => console.warn('[ride-accept] push failed:', err));

    res.status(200).json({ success: true, data: { ride: driverFacingRide } });
  } catch (error) {
    console.error('acceptRide error:', error);
    res.status(500).json({ success: false, message: 'Failed to accept ride' });
  }
};

/**
 * PUT /api/v1/rides/:id/reject  (Driver)
 *
 * Drivers can opt out of a request without affecting the ride state — the
 * dispatcher fan-out already targeted multiple drivers, so any one of them
 * declining isn't terminal. We just record it for analytics so we can spot
 * drivers with high reject rates later.
 */
export const rejectRide = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { reason } = req.body as { reason?: string };
    const ride = await Ride.findById(req.params.id);
    if (!ride) {
      res.status(404).json({ success: false, message: 'Ride not found' });
      return;
    }
    // No-op if the ride was already claimed — driver was just slow.
    if (ride.status !== 'searching') {
      res.status(200).json({ success: true, data: { ride } });
      return;
    }

    // Track the reject for ops dashboards. Bounded array — keep last 20.
    const rejection = {
      driver: req.user!._id,
      reason: reason || 'No reason provided',
      rejectedAt: new Date(),
    };
    await Ride.updateOne(
      { _id: ride._id },
      {
        $push: {
          rejections: { $each: [rejection], $slice: -20 },
        },
      },
    );

    res.status(200).json({ success: true, data: { rideId: ride._id } });
  } catch (error) {
    console.error('rejectRide error:', error);
    res.status(500).json({ success: false, message: 'Failed to reject ride' });
  }
};

/**
 * GET /api/v1/rides/available  (Driver)
 *
 * Returns the ride requests currently offered to this driver — the pull-based
 * complement to the socket `ride:new-request` push. Reading shared DB state
 * (not per-instance socket rooms) means it works on a multi-instance / split
 * deployment where `emitToUser` can't cross processes, so the driver app can
 * populate its in-app "Incoming Requests" list (and pop the modal) even when
 * the socket push never arrives — the same reason FCM keeps working.
 *
 * Mirrors `dispatchToNearbyDrivers` selection exactly: online driver, matching
 * tier (serviceType) + vehicleTypeCode (or unset), not busy, within 7 km of a
 * still-`searching` ride's pickup, and not already rejected by this driver.
 * The payload shape is identical to the socket `ridePayload`.
 */
export const getAvailableRides = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const driver = await User.findById(req.user!._id).select(
      '_id role driverProfile.isOnline driverProfile.serviceType ' +
        'driverProfile.vehicleTypeCode driverProfile.currentLocation',
    );
    if (!driver || driver.role !== 'driver') {
      res.status(403).json({ success: false, message: 'Drivers only' });
      return;
    }

    const dp: any = driver.driverProfile;
    const loc = dp?.currentLocation;
    // Same gate as dispatch: only online drivers with a known location are
    // offered rides. Silently return an empty list otherwise.
    if (
      !dp?.isOnline ||
      !loc ||
      typeof loc.lat !== 'number' ||
      typeof loc.lng !== 'number'
    ) {
      res.status(200).json({ success: true, data: { rides: [] } });
      return;
    }

    // A driver already on a ride must not be offered new ones.
    const busy = await Ride.exists({
      driver: driver._id,
      status: {
        $in: ['driver_assigned', 'driver_arriving', 'driver_arrived', 'in_progress'],
      },
    });
    if (busy) {
      res.status(200).json({ success: true, data: { rides: [] } });
      return;
    }

    const serviceType = dp.serviceType;
    // Pending rides still looking for a driver, excluding ones this driver
    // has already rejected. Newest first; cap the scan cheaply.
    const searching = await Ride.find({
      status: 'searching',
      'rejections.driver': { $ne: driver._id },
    })
      .populate('customer', 'firstName lastName')
      .sort({ createdAt: -1 })
      .limit(50);

    const { VehicleType } = await import('../models');
    const RADIUS_KM = 7;
    const KM_PER_DEG_LAT = 111;
    const kmPerDegLng = 111 * Math.cos((loc.lat * Math.PI) / 180) || 111;

    const rides: any[] = [];
    for (const ride of searching) {
      const pickup: any = ride.pickup;
      const dropoff: any = ride.dropoff;
      if (!pickup || typeof pickup.lat !== 'number' || typeof pickup.lng !== 'number') {
        continue;
      }

      // Distance filter — same flat-earth approximation the dispatch uses.
      const dLatKm = (loc.lat - pickup.lat) * KM_PER_DEG_LAT;
      const dLngKm = (loc.lng - pickup.lng) * kmPerDegLng;
      const distKm = Math.sqrt(dLatKm * dLatKm + dLngKm * dLngKm);
      if (distKm > RADIUS_KM) continue;

      // Resolve the ride's tier the same way dispatch does.
      const requestedType = ride.rideType
        ? await VehicleType.findOne({
            code: String(ride.rideType).toLowerCase(),
          }).select('code tier')
        : null;
      const expectedTier =
        (requestedType as any)?.tier ?? (ride.isPrivate ? 'private' : 'instant');
      if (serviceType !== expectedTier) continue;

      // vehicleTypeCode narrowing: only exclude a driver whose set code
      // mismatches (unset code = eligible), exactly like the dispatch $or.
      if (
        (requestedType as any)?.code &&
        dp.vehicleTypeCode &&
        dp.vehicleTypeCode !== (requestedType as any).code
      ) {
        continue;
      }

      const c: any = ride.customer || {};
      const customerName =
        [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Passenger';

      rides.push({
        rideId: String(ride._id),
        variant: expectedTier,
        passengerName: customerName,
        pickup: pickup.address,
        drop: dropoff?.address ?? '',
        pickupLat: pickup.lat,
        pickupLng: pickup.lng,
        dropLat: dropoff?.lat,
        dropLng: dropoff?.lng,
        fare: ride.estimatedFare,
        distance: ride.estimatedDistance,
        duration: ride.estimatedDuration,
      });
    }

    res.status(200).json({ success: true, data: { rides } });
  } catch (error) {
    console.error('getAvailableRides error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch available rides' });
  }
};

/**
 * PUT /api/v1/rides/:id/verify-otp  (Driver)
 *
 * Driver enters the 4-digit OTP the passenger reads aloud. We compare it
 * against the one we generated at ride creation. On success the ride
 * transitions straight to 'in_progress' and the OTP is cleared so it can't
 * be replayed. The status emit lets the customer's tracking screen flip
 * its banner to "On your way to destination" without a refetch.
 */
export const verifyRideOtp = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { otp } = req.body as { otp?: string };
    if (!otp || !/^\d{4}$/.test(otp)) {
      res.status(400).json({ success: false, message: 'Enter the 4-digit OTP.' });
      return;
    }

    const ride = await Ride.findById(req.params.id);
    if (!ride) {
      res.status(404).json({ success: false, message: 'Ride not found' });
      return;
    }
    if (String(ride.driver) !== String(req.user!._id)) {
      res.status(403).json({ success: false, message: 'Not your ride' });
      return;
    }
    // OTP verification only makes sense while the ride is live and pre-trip.
    // A cancelled ride can still carry a pickupOtp (cancel doesn't clear it),
    // so without this a cancelled ride could be flipped to 'in_progress' by
    // entering the OTP.
    if (!['driver_assigned', 'driver_arriving', 'driver_arrived'].includes(ride.status)) {
      res.status(400).json({
        success: false,
        message: 'This ride is not ready to start.',
      });
      return;
    }
    // OTP only meaningful between assignment and trip start. After that
    // the field is cleared, so a missing OTP also means "already used".
    if (!ride.pickupOtp) {
      res.status(400).json({
        success: false,
        message: 'OTP no longer required for this ride.',
      });
      return;
    }
    if (ride.pickupOtp !== otp) {
      res.status(400).json({ success: false, message: 'Incorrect OTP.' });
      return;
    }

    ride.pickupOtp = undefined;
    ride.status = 'in_progress';
    ride.startedAt = new Date();
    await ride.save();

    emitToRide(String(ride._id), 'ride:status', {
      rideId: ride._id,
      status: 'in_progress',
      ride,
    });
    emitToUser(String(ride.customer), 'ride:status', {
      rideId: ride._id,
      status: 'in_progress',
      ride,
    });

    res.status(200).json({ success: true, data: { ride } });
  } catch (error) {
    console.error('verifyRideOtp error:', error);
    res.status(500).json({ success: false, message: 'OTP verification failed' });
  }
};

/**
 * PUT /api/v1/rides/:id/status  (Driver)
 * Update ride status progression
 */
export const updateRideStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { status } = req.body;
    // Transitions overview:
    //   in_progress → payment_pending : driver pressed "End trip". Fare
    //     is locked in now (actualFare/Distance/Duration) but the rider
    //     hasn't paid yet. Wallet, Razorpay, and driver "cash collected"
    //     paths all close this out.
    //   payment_pending → completed   : settlement has been recorded.
    //     This is where commissions, driver earnings, wallet credit, and
    //     payment records are written. After this point the trip is final.
    // This is the DRIVER-facing progression endpoint. Two transitions were
    // removed for safety:
    //   • driver_arrived → in_progress : trip start MUST go through
    //     verifyRideOtp (the OTP gate). Allowing it here let a driver start
    //     the trip without the passenger's OTP.
    //   • payment_pending → completed  : settlement MUST go through a payment
    //     path (wallet pay-ride / Razorpay verify / driver cash-confirm), all
    //     of which call finalizeRideSettlement. Allowing a driver to
    //     self-complete credited their wallet with NO payment collected.
    // 'driver_arrived' is also reachable directly from 'driver_assigned' so
    // the "I've arrived" button works before the geofence flips to arriving.
    const validTransitions: Record<string, string[]> = {
      driver_assigned: ['driver_arriving', 'driver_arrived'],
      driver_arriving: ['driver_arrived'],
      in_progress: ['payment_pending'],
    };

    const ride = await Ride.findById(req.params.id);
    if (!ride) {
      res.status(404).json({ success: false, message: 'Ride not found' });
      return;
    }

    // Only the assigned driver (or an admin) may move a ride's status. Without
    // this, any authenticated account could walk an arbitrary ride through its
    // lifecycle (and, via the old completed transition, settle it).
    const isAdmin = req.user!.role === 'admin';
    if (!isAdmin && (!ride.driver || String(ride.driver) !== String(req.user!._id))) {
      res.status(403).json({
        success: false,
        message: 'Only the assigned driver can update this ride',
      });
      return;
    }

    if (!validTransitions[ride.status]?.includes(status)) {
      res.status(400).json({
        success: false,
        message: `Cannot transition from ${ride.status} to ${status}`,
      });
      return;
    }

    ride.status = status;
    if (status === 'in_progress') ride.startedAt = new Date();

    // Step 1 of completion — fare is locked in here so the receipt the
    // customer sees on RideComplete and the amount we charge the wallet/
    // Razorpay are guaranteed to match what's on the ride doc.
    if (status === 'payment_pending') {
      ride.completedAt = new Date();
      ride.actualFare = ride.estimatedFare; // In production, recalculate
      ride.actualDistance = ride.estimatedDistance;
      // Real elapsed minutes from pickup-OTP verification to ride end.
      // Falls back to the original estimate if startedAt is somehow
      // missing (legacy rides or admin force-completion paths).
      if (ride.startedAt) {
        const elapsedMs = ride.completedAt.getTime() - ride.startedAt.getTime();
        ride.actualDuration = Math.max(1, Math.round(elapsedMs / 60000));
      } else {
        ride.actualDuration = ride.estimatedDuration;
      }
    }

    // (Settlement — commission, driver earnings, wallet credit, payment rows,
    // incentives — is NOT done here anymore. It lives solely in
    // finalizeRideSettlement, invoked by the payment paths, so it runs exactly
    // once and only after money is actually collected.)

    await ride.save();

    // Push the new status to everyone watching this ride (customer +
    // driver), and also direct-emit to the customer in case they haven't
    // joined the ride room yet (cold-start race).
    emitToRide(String(ride._id), 'ride:status', { rideId: ride._id, status, ride });
    emitToUser(String(ride.customer), 'ride:status', {
      rideId: ride._id,
      status,
      ride,
    });

    res.status(200).json({ success: true, data: { ride } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Status update failed' });
  }
};

/**
 * PUT /api/v1/rides/:id/cancel
 */
export const cancelRide = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { reason } = req.body;
    const ride = await Ride.findById(req.params.id);

    if (!ride) {
      res.status(404).json({ success: false, message: 'Ride not found' });
      return;
    }

    if (['completed', 'cancelled'].includes(ride.status)) {
      res.status(400).json({ success: false, message: 'Ride cannot be cancelled' });
      return;
    }
    // payment_pending means the trip physically ended and the fare is locked —
    // the driver drove the whole route and must be paid. Cancelling here let a
    // rider ride for free (no settlement runs, and the fee list below excludes
    // payment_pending so fee=0). Pay the ride instead of cancelling it.
    if (ride.status === 'payment_pending') {
      res.status(400).json({
        success: false,
        message: 'This trip has ended and is awaiting payment. Please pay for the ride.',
      });
      return;
    }

    // Only the ride's own customer or assigned driver may cancel it (admins
    // use the admin route). Without this, any authenticated user could cancel
    // anyone's ride by id — and trigger a cancellation fee on that customer.
    const uid = req.user!._id.toString();
    const isCustomer = ride.customer?.toString() === uid;
    const isDriver = !!ride.driver && ride.driver.toString() === uid;
    if (!isCustomer && !isDriver) {
      res.status(403).json({ success: false, message: 'Not authorized to cancel this ride' });
      return;
    }

    const cancelledBy = isDriver ? 'driver' : 'customer';

    // Once the trip is physically IN PROGRESS the customer can no longer
    // cancel — the driver is mid-route and cancelling skipped settlement
    // entirely, so the whole trip became free (driver earned ₹0 and only a
    // flat cancellation fee was charged). Same class of hole as the
    // payment_pending guard above. The driver (breakdown, emergency) and
    // admin routes can still cancel a live trip.
    if (ride.status === 'in_progress' && !isDriver) {
      res.status(400).json({
        success: false,
        message:
          'Your trip is already in progress. Ask your driver to end the trip — you will only be charged for the distance travelled.',
      });
      return;
    }

    // A cancellation fee only applies when the CUSTOMER cancels late — never
    // when the driver bails. Previously the fee was charged regardless of who
    // cancelled, so a driver cancelling mid-trip generated a fee against the
    // (innocent) customer. (in_progress no longer reaches here for customers.)
    //
    // Driver-fault reasons are also waived: the app's own preset list includes
    // "Waiting for long time" / "Unable to contact driver" / "Driver denied…",
    // yet the reason was stored and never consulted — the rider paid a fee for
    // the driver's failure. Matched loosely so free-text variants count too.
    const DRIVER_FAULT_REASON = /waiting for long|unable to contact driver|driver denied|driver asked/i;
    const isDriverFault = DRIVER_FAULT_REASON.test(String(reason ?? ''));
    const hasFee =
      cancelledBy === 'customer' &&
      !isDriverFault &&
      ['driver_arriving', 'driver_arrived'].includes(ride.status);
    const fee = hasFee ? (await getRideSettings()).cancellationFee : 0;

    // Atomic cancel claim. This was read-check-save: two overlapping requests
    // (double-tap, or the rider cancelling as the driver does) both read a
    // live status, both passed the guard above, and both ran the fee debit —
    // charging the customer twice. The conditional filter means only the first
    // writer matches; the loser bails out below without side effects.
    const claimed = await Ride.findOneAndUpdate(
      { _id: ride._id, status: { $nin: ['cancelled', 'completed', 'payment_pending'] } },
      {
        $set: {
          status: 'cancelled',
          cancellation: {
            cancelledBy,
            reason: reason || 'No reason provided',
            fee,
            refundAmount: 0, // set below once the refund actually succeeds
            cancelledAt: new Date(),
          },
        },
      },
      { new: true },
    );
    if (!claimed) {
      // Lost the race — already cancelled/settled by another request.
      const current = await Ride.findById(ride._id);
      res.status(200).json({ success: true, message: 'Ride already cancelled', data: { ride: current, fee: 0 } });
      return;
    }
    // Use the claimed document for everything downstream.
    (ride as any).status = claimed.status;
    (ride as any).cancellation = claimed.cancellation;

    // ── Money moves below run EXACTLY ONCE (guarded by the claim above) ──

    // If the fare was already PAID, give it back. Payment normally happens at
    // completion, so a cancelled ride is usually unpaid and nothing is owed —
    // but when a ride was prepaid there was no refund path at all, leaving the
    // rider out of pocket while we still charged a cancel fee. Deliberately
    // AFTER the claim: doing it before meant a request that lost the race had
    // already issued a second refund.
    let refundAmount = 0;
    if (ride.paymentStatus === 'completed') {
      const paid = await Payment.findOne({
        ride: ride._id,
        type: 'ride_payment',
        status: 'completed',
      }).sort({ createdAt: -1 });
      const paidAmt = Math.max(0, Number(paid?.amount ?? ride.actualFare ?? 0));
      if (paidAmt > 0) {
        await Wallet.findOneAndUpdate(
          { user: ride.customer },
          { $inc: { balance: paidAmt } },
          { upsert: true, new: true },
        );
        await Payment.create({
          user: ride.customer,
          ride: ride._id,
          type: 'ride_payment',
          amount: paidAmt,
          method: 'wallet',
          status: 'refunded',
          description: 'Refund for cancelled ride',
        });
        refundAmount = paidAmt;
        await Ride.updateOne(
          { _id: ride._id },
          { $set: { paymentStatus: 'refunded', 'cancellation.refundAmount': paidAmt } },
        );
        (ride as any).paymentStatus = 'refunded';
        if ((ride as any).cancellation) (ride as any).cancellation.refundAmount = paidAmt;
      }
    }

    // A manual cancel overrides the 5-minute auto-cancel timer.
    clearAutoCancel(String(ride._id));

    // Tell any dispatched drivers to dismiss their request modals — the
    // customer no longer wants this ride.
    if (ride.status === 'cancelled') {
      const dispatched = await takeDispatchedDrivers(String(ride._id));
      await broadcastRequestTaken(String(ride._id), dispatched);
    }
    // Notify the *other* party. Customer cancels → tell driver; driver
    // cancels → tell customer. Either way the recipient's UI dismisses
    // tracking/waiting screens and lets them start fresh.
    if (cancelledBy === 'customer' && ride.driver) {
      emitToUser(ride.driver.toString(), 'ride:cancelled', {
        rideId: String(ride._id),
        reason: claimed.cancellation?.reason,
        cancelledBy,
        message: 'The customer cancelled this ride.',
      });
    } else if (cancelledBy === 'driver') {
      emitToUser(ride.customer.toString(), 'ride:cancelled', {
        rideId: String(ride._id),
        reason: claimed.cancellation?.reason,
        cancelledBy,
        message: 'The driver cancelled this ride. You can book a new one.',
      });
    }

    // Cancellation fee — actually collect it from the wallet instead of just
    // writing a `completed` ledger row for money that never moved (which
    // overstated revenue). If the wallet can't cover it, record the fee as
    // `pending` (owed) rather than pretending it was paid.
    if (fee > 0) {
      const debited = await Wallet.findOneAndUpdate(
        { user: ride.customer, balance: { $gte: fee } },
        { $inc: { balance: -fee } },
        { new: true },
      );
      await Payment.create({
        user: ride.customer,
        ride: ride._id,
        type: 'cancellation_fee',
        amount: fee,
        method: 'wallet',
        status: debited ? 'completed' : 'pending',
        description: debited
          ? 'Cancellation fee'
          : 'Cancellation fee (unpaid — insufficient wallet balance)',
      });
    }

    res.status(200).json({ success: true, message: 'Ride cancelled', data: { ride, fee } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Cancellation failed' });
  }
};

/**
 * PUT /api/v1/rides/:id/simulate-complete
 * Demo endpoint: auto-complete a ride (no real driver needed)
 */
export const simulateComplete = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    // Demo-only: this self-completes a ride and writes a completed Payment
    // with NO driver settlement/commission, bypassing the real flow. Disabled
    // outside development so it can't be abused in production.
    if (config.env === 'production') {
      res.status(404).json({ success: false, message: 'Not found' });
      return;
    }

    const ride = await Ride.findOne({ _id: req.params.id, customer: req.user!._id });
    if (!ride) {
      res.status(404).json({ success: false, message: 'Ride not found' });
      return;
    }
    if (ride.status === 'completed' || ride.status === 'cancelled') {
      res.status(400).json({ success: false, message: 'Ride already finished' });
      return;
    }

    ride.status = 'completed';
    ride.startedAt = ride.startedAt || new Date(Date.now() - (ride.estimatedDuration || 15) * 60000);
    ride.completedAt = new Date();
    ride.actualFare = ride.estimatedFare;
    ride.actualDistance = ride.estimatedDistance;
    // Real elapsed minutes from startedAt to now so the receipt's duration
    // matches the ride-start/ride-end timestamps shown alongside it.
    {
      const elapsedMs = ride.completedAt.getTime() - ride.startedAt.getTime();
      ride.actualDuration = Math.max(1, Math.round(elapsedMs / 60000));
    }
    ride.paymentStatus = 'completed';

    // Create payment record
    await Payment.create({
      user: ride.customer,
      ride: ride._id,
      type: 'ride_payment',
      amount: ride.actualFare,
      method: ride.paymentMethod,
      status: 'completed',
      description: `Ride payment - ${ride.rideType}`,
    });

    await ride.save();
    processRideForIncentives(ride).catch((err) =>
      console.error('[incentives] processRideForIncentives failed:', err)
    );
    awardPointsForRide(ride).catch((err) =>
      console.error('[loyalty] awardPointsForRide failed:', err)
    );
    res.status(200).json({ success: true, data: { ride } });
  } catch (error) {
    console.error('simulateComplete error:', error);
    res.status(500).json({ success: false, message: 'Simulation failed' });
  }
};

/**
 * PUT /api/v1/rides/:id/rate
 */
export const rateRide = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, errors: errors.array() });
      return;
    }

    const { rating, comment, tags, tip } = req.body;
    const ride = await Ride.findById(req.params.id);

    // A rating is about the TRIP experience, so it's allowed as soon as the
    // trip has physically ended — `payment_pending` (driver pressed End Trip)
    // or `completed`. Requiring `completed` meant a cash ride (the default
    // payment method) could never be rated until the driver confirmed cash,
    // which the rider's rating almost always raced ahead of → "not completed".
    if (!ride || !['completed', 'payment_pending'].includes(ride.status)) {
      res.status(400).json({ success: false, message: 'Ride not found or not completed' });
      return;
    }

    // Only the ride's customer or assigned driver may rate it. Previously a
    // non-participant fell through to the driver branch and could move the
    // driver's rating average / add a tip on a ride they weren't part of.
    const uid = req.user?._id.toString();
    const isCustomer = ride.customer.toString() === uid;
    const isDriver = !!ride.driver && ride.driver.toString() === uid;
    if (!isCustomer && !isDriver) {
      res.status(403).json({ success: false, message: 'Not authorized to rate this ride' });
      return;
    }

    // One rating per party per ride. There was no re-rating guard at all, so
    // a rating could be overwritten forever (each overwrite also re-entering
    // the driver-average recompute) and every re-submit blanked the previous
    // comment/tags with undefined.
    if (isCustomer && (ride.rating?.customerToDriver ?? 0) > 0) {
      res.status(400).json({
        success: false,
        message: 'You have already rated this trip.',
      });
      return;
    }
    if (isDriver && (ride.rating?.driverToCustomer ?? 0) > 0) {
      res.status(400).json({
        success: false,
        message: 'You have already rated this rider.',
      });
      return;
    }

    if (!ride.rating) {
      ride.rating = {} as any;
    }

    if (isCustomer) {
      ride.rating!.customerToDriver = rating;
      if (comment !== undefined) ride.rating!.customerComment = comment;
      if (tags !== undefined) ride.rating!.tags = tags;

      // Tip — idempotent (applied at most once) and actually moved from the
      // customer's wallet to the driver's wallet. Previously it (a) stacked on
      // every re-submit via `driverEarnings += tip`, (b) recorded a
      // "completed" charge that never debited the customer, and (c) credited
      // only the driver's stat, never their spendable wallet.
      if (tip && tip > 0 && !(ride.tip && ride.tip > 0)) {
        const tipAmt = Math.round(Number(tip) * 100) / 100;
        const debited = await Wallet.findOneAndUpdate(
          { user: ride.customer, balance: { $gte: tipAmt } },
          { $inc: { balance: -tipAmt } },
          { new: true },
        );
        if (!debited) {
          res.status(400).json({
            success: false,
            message: 'Insufficient wallet balance to tip. Top up your wallet and try again.',
          });
          return;
        }
        ride.tip = tipAmt;

        await Payment.create({
          user: ride.customer,
          ride: ride._id,
          type: 'tip',
          amount: tipAmt,
          method: 'wallet',
          status: 'completed',
          description: 'Driver tip',
        });

        // Credit the driver directly ONLY if settlement has already run
        // (ride completed). If the ride is still payment_pending, leave the
        // driver side to finalizeRideSettlement — it computes driverEarnings as
        // actualFare − commission + ride.tip and credits the wallet, so
        // crediting here too would double-pay the tip.
        if (ride.status === 'completed' && ride.driver) {
          ride.driverEarnings = (ride.driverEarnings || 0) + tipAmt;
          await Wallet.findOneAndUpdate(
            { user: ride.driver },
            { $inc: { balance: tipAmt } },
            { upsert: true },
          );
          await User.findByIdAndUpdate(ride.driver, {
            $inc: { 'driverProfile.totalEarnings': tipAmt },
          });
          await Payment.create({
            user: ride.driver,
            ride: ride._id,
            type: 'tip',
            amount: tipAmt,
            method: 'wallet',
            status: 'completed',
            description: 'Tip received',
          });
        }
        await ride.save();
      }

      // Update driver rating (running average). Include the current rating —
      // this ride isn't saved yet, so the query alone would omit it — and guard
      // the divide so a driver's FIRST rating doesn't compute 0/0 = NaN (which
      // could throw when written to the Number `driverProfile.rating`, showing
      // up to the rider as "rating failed").
      if (ride.driver) {
        const driverRides = await Ride.find({
          driver: ride.driver,
          _id: { $ne: ride._id },
          'rating.customerToDriver': { $gt: 0 },
        }).select('rating.customerToDriver');

        const scores = driverRides
          .map(r => r.rating?.customerToDriver || 0)
          .filter(n => n > 0);
        scores.push(rating);
        const avgRating = scores.reduce((sum, n) => sum + n, 0) / scores.length;

        await User.findByIdAndUpdate(ride.driver, {
          'driverProfile.rating': Math.round(avgRating * 100) / 100,
          // Real count of ratings received. The apps show the true average
          // once this is > 0, and a friendly 5.0 before then.
          'driverProfile.ratingCount': scores.length,
        });
      }
    } else {
      ride.rating!.driverToCustomer = rating;
      if (comment !== undefined) ride.rating!.driverComment = comment;
    }

    await ride.save();
    res.status(200).json({ success: true, message: 'Rating submitted', data: { ride } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Rating failed' });
  }
};
