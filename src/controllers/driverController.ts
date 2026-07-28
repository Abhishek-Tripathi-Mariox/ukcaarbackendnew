import { Response } from 'express';
import mongoose from 'mongoose';
import { User, Ride, Payment, Route } from '../models';
import { AuthRequest } from '../middleware/auth';
import { config } from '../config';
import { createOrder } from './paymentController';

const REGISTRATION_STEPS = [
  'service-type',
  'vehicle-details',
  'owner-details',
  'driver-details',
  'complete-profile',
  'pending',
  'approved',
  'rejected',
] as const;
type RegistrationStep = typeof REGISTRATION_STEPS[number];

/**
 * PUT /api/v1/driver/registration/step
 *
 * Saves the user's progress through driver registration so it can be
 * resumed on relogin. The first call also flips `role: customer → driver`
 * (the OTP flow creates everyone as a customer by default).
 *
 * Body:
 *   step: one of REGISTRATION_STEPS — the step the user just completed
 *         (or the screen they're now on). The client decides which.
 *   data: optional partial driverProfile patch for that step
 *         (e.g. { serviceType: 'private' } from ChooseServiceTypeScreen).
 */
export const updateRegistrationStep = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { step, data } = req.body ?? {};
    if (!step || !REGISTRATION_STEPS.includes(step)) {
      res.status(400).json({
        success: false,
        message: `step must be one of: ${REGISTRATION_STEPS.join(', ')}`,
      });
      return;
    }

    // 'approved' / 'rejected' are admin-controlled outcomes — the driver
    // app should not be able to self-approve.
    if (step === 'approved' || step === 'rejected') {
      res.status(403).json({
        success: false,
        message: 'This step can only be set by an admin.',
      });
      return;
    }

    const update: Record<string, any> = {
      role: 'driver',
      'driverProfile.registrationStep': step as RegistrationStep,
    };

    // Allow each step to write its own subset of driverProfile fields.
    // We whitelist explicitly so the client can't overwrite ratings,
    // earnings, online state, etc.
    const ALLOWED_FIELDS = new Set([
      'serviceType',
      'licenceNumber',
      'licenceExpiry',
      'yearsExperience',
      'vehicleMake',
      'vehicleModel',
      'vehicleYear',
      'vehicleColor',
      'seatingCapacity',
      'plateNumber',
      'insuranceNumber',
      'insuranceExpiry',
      'vehicleTypeCode',
      'fuelTypeCode',
      'ownerName',
      'ownerContact',
      'ownerAddress',
      // Bank details — captured on the "complete profile" step. Stored as a
      // single subdoc so admin can read them in one shot.
      'bankDetails',
    ]);
    // User-root fields the registration form is allowed to set (not under
    // driverProfile.*). dob lives here; firstName/lastName are split from
    // a single fullName field on the client.
    const USER_ROOT_FIELDS = new Set([
      'firstName',
      'lastName',
      'email',
      'dob',
    ]);
    if (data && typeof data === 'object') {
      for (const [key, value] of Object.entries(data)) {
        if (ALLOWED_FIELDS.has(key)) {
          update[`driverProfile.${key}`] = value;
        } else if (USER_ROOT_FIELDS.has(key)) {
          update[key] = value;
        }
      }
    }

    // 'pending' means they finished the form and are waiting on admin review.
    // Mark the profile as setup so the verify-otp routing knows we're done.
    if (step === 'pending') {
      update.isProfileSetup = true;
    }

    const user = await User.findByIdAndUpdate(req.user!._id, update, {
      new: true,
    });
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    res.status(200).json({
      success: true,
      data: {
        registrationStep: user.driverProfile?.registrationStep ?? null,
        role: user.role,
        isProfileSetup: user.isProfileSetup,
      },
    });
  } catch (error) {
    console.error('updateRegistrationStep error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update registration step',
    });
  }
};

/**
 * PUT /api/v1/driver/toggle-online
 */
export const toggleOnline = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { isOnline, lat, lng } = req.body;

    const updateData: Record<string, any> = {
      'driverProfile.isOnline': isOnline,
    };
    if (lat && lng) {
      updateData['driverProfile.currentLocation'] = { lat, lng };
    }

    const user = await User.findByIdAndUpdate(req.user!._id, updateData, { new: true });

    console.log(
      `[toggle-online] driver=${req.user!._id} isOnline=${isOnline} ` +
      `coords=${lat && lng ? `${lat},${lng}` : 'none'} ` +
      `stored=${JSON.stringify(user?.driverProfile?.currentLocation ?? null)}`,
    );

    res.status(200).json({
      success: true,
      data: {
        isOnline: user?.driverProfile?.isOnline,
        currentLocation: user?.driverProfile?.currentLocation,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to toggle status' });
  }
};

/**
 * PUT /api/v1/driver/location
 * Update driver's current location (called frequently)
 */
export const updateLocation = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { lat, lng } = req.body;
    if (!lat || !lng) {
      res.status(400).json({ success: false, message: 'Coordinates required' });
      return;
    }

    await User.findByIdAndUpdate(req.user!._id, {
      'driverProfile.currentLocation': { lat, lng },
    });

    res.status(200).json({ success: true, message: 'Location updated' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Location update failed' });
  }
};

/**
 * GET /api/v1/driver/nearby-drivers
 * Find nearby online drivers (used by customer app for map display)
 */
export const getNearbyDrivers = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const lat = parseFloat(req.query.lat as string);
    const lng = parseFloat(req.query.lng as string);
    const radiusKm = parseFloat(req.query.radius as string) || 5;

    if (!lat || !lng) {
      res.status(400).json({ success: false, message: 'Coordinates required' });
      return;
    }

    // Find online drivers within radius (simplified; in production use $geoNear)
    const drivers = await User.find({
      role: 'driver',
      'driverProfile.isOnline': true,
      isActive: true,
    }).select('firstName driverProfile.currentLocation driverProfile.rating driverProfile.vehicleMake driverProfile.vehicleModel driverProfile.vehicleColor');

    // Drivers who are an approved registration on an active scheduled
    // Route run shuttle service — they should NOT appear on the
    // instant/private map or count toward the "X cabs nearby" badge.
    // Pulls the set in one query so the filter below is O(1) per driver.
    const { Route } = await import('../models');
    const scheduledRoutes = await Route.find({
      isActive: true,
      type: 'scheduled',
      registeredDrivers: { $elemMatch: { status: 'approved' } },
    })
      .select('registeredDrivers')
      .lean();
    const scheduledDriverIds = new Set<string>();
    for (const r of scheduledRoutes) {
      for (const reg of (r.registeredDrivers ?? []) as any[]) {
        if (reg?.status === 'approved' && reg?.driver) {
          scheduledDriverIds.add(String(reg.driver));
        }
      }
    }

    // Filter by distance (simplified). Also drop any driver who's on a
    // scheduled route — those are shuttle drivers, not instant cabs.
    const withLocation = drivers.filter(
      (d) =>
        !!d.driverProfile?.currentLocation &&
        !scheduledDriverIds.has(String(d._id)),
    );
    const nearbyDrivers = withLocation.filter((driver) => {
      const dLat = driver.driverProfile!.currentLocation!.lat - lat;
      const dLng = driver.driverProfile!.currentLocation!.lng - lng;
      const dist = Math.sqrt(dLat ** 2 + dLng ** 2) * 111; // rough km
      return dist <= radiusKm;
    });

    console.log(
      `[nearby] center=${lat},${lng} radius=${radiusKm}km ` +
      `online=${drivers.length} withLocation=${withLocation.length} ` +
      `inRadius=${nearbyDrivers.length}`,
    );

    res.status(200).json({
      success: true,
      data: {
        drivers: nearbyDrivers.map((d) => ({
          id: d._id,
          name: d.firstName,
          location: d.driverProfile?.currentLocation,
          rating: d.driverProfile?.rating,
          vehicle: {
            make: d.driverProfile?.vehicleMake,
            model: d.driverProfile?.vehicleModel,
            color: d.driverProfile?.vehicleColor,
          },
        })),
        count: nearbyDrivers.length,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch drivers' });
  }
};

/**
 * POST /api/v1/drivers/onepass/subscribe
 * OnePass is a PAID subscription. This no longer free-activates — it creates a
 * Razorpay order for the chosen plan and delegates to the payment flow. The
 * driver pays via native checkout, then /payments/verify-payment activates
 * OnePass server-side. Kept for backward compatibility with the route.
 */
export const subscribeOnePass = async (req: AuthRequest, res: Response): Promise<void> => {
  req.body = { ...req.body, type: 'subscription' };
  return createOrder(req, res);
};

/**
 * GET /api/v1/drivers/me/ratings
 * Aggregated rider feedback for the signed-in driver: overall average, count,
 * a 7-day trend, the most common feedback tags, and recent comments. All
 * derived from real Ride.rating data (customerToDriver).
 */
export const getMyRatings = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const driverId = new mongoose.Types.ObjectId(req.user!._id);
    const rated = await Ride.find({
      driver: driverId,
      'rating.customerToDriver': { $gt: 0 },
    })
      .select('rating completedAt createdAt customer')
      .populate('customer', 'firstName lastName avatar')
      .sort({ completedAt: -1, createdAt: -1 })
      .limit(300)
      .lean();

    const scores = rated.map((r) => r.rating!.customerToDriver as number);
    const totalRides = scores.length;
    const overallRating = totalRides
      ? Math.round((scores.reduce((a, b) => a + b, 0) / totalRides) * 10) / 10
      : 0;

    // Recent reviews, enriched with the reviewer's name/avatar/date so the
    // driver dashboard's Reviews card can render real rows (name • date •
    // stars • text) instead of Figma placeholder people. Star-only ratings
    // (no written comment) ARE included — they just render without a comment
    // line; previously they were filtered out and invisible on the dashboard.
    const comments = rated
      .slice(0, 10)
      .map((r, i) => {
        const c: any = (r as any).customer;
        const reviewerName = c
          ? [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Rider'
          : 'Rider';
        return {
          id: String((r as any)._id ?? i),
          stars: r.rating!.customerToDriver as number,
          text: (r.rating?.customerComment as string) || '',
          source: 'Rider',
          reviewerName,
          reviewerAvatar: c?.avatar ?? null,
          date: ((r as any).completedAt || (r as any).createdAt) ?? null,
        };
      });

    // Last-7-days trend: average rating per day (0 when no ratings that day).
    const dayMs = 24 * 60 * 60 * 1000;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const buckets: { sum: number; n: number }[] = Array.from({ length: 7 }, () => ({ sum: 0, n: 0 }));
    rated.forEach((r) => {
      const when = r.completedAt || r.createdAt;
      if (!when) return;
      const d = new Date(when);
      d.setHours(0, 0, 0, 0);
      const idx = 6 - Math.round((today.getTime() - d.getTime()) / dayMs);
      if (idx >= 0 && idx < 7) {
        buckets[idx].sum += r.rating!.customerToDriver as number;
        buckets[idx].n += 1;
      }
    });
    const weeklyTrend = buckets.map((b) => (b.n ? Math.round((b.sum / b.n) * 10) / 10 : 0));

    // Metrics from the feedback tags riders actually selected, scaled to 0-5
    // bars by relative frequency (the most-given tag = 5).
    const tagCounts: Record<string, number> = {};
    rated.forEach((r) =>
      (r.rating?.tags ?? []).forEach((t: string) => {
        tagCounts[t] = (tagCounts[t] ?? 0) + 1;
      })
    );
    const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const maxTag = topTags[0]?.[1] || 1;
    const metrics = topTags.map(([label, count]) => ({
      label,
      value: Math.round((count / maxTag) * 5 * 10) / 10,
    }));

    res.json({
      success: true,
      data: { overallRating, totalRides, weeklyTrend, comments, metrics },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to load ratings' });
  }
};

/**
 * GET /api/v1/drivers/onepass/plans
 * Server-authoritative OnePass plans (label + price + days) for the app to render.
 */
export const getOnePassPlans = async (_req: AuthRequest, res: Response): Promise<void> => {
  // Admin-configured plans (Settings) with a config fallback — a driver can
  // only ever be offered a plan/price the admin actually set.
  const { resolveOnePassPlans } = await import('../utils/onePassPlans');
  const all = await resolveOnePassPlans();
  const plans = all
    .filter((p) => p.active)
    .map((p) => ({
      key: p.key,
      label: p.label,
      price: p.price,
      days: p.days,
      currency: config.onePass.currency,
    }));
  res.json({ success: true, data: { plans } });
};

/**
 * GET /api/v1/drivers/onepass/status
 * The driver's current OnePass state (active + expiry).
 */
export const getOnePassStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await User.findById(req.user!._id).select(
      'driverProfile.isOnePass driverProfile.onePassExpiry'
    );
    const dp: any = (user as any)?.driverProfile ?? {};
    const expiry = dp.onePassExpiry ? new Date(dp.onePassExpiry) : null;
    const isActive = !!dp.isOnePass && !!expiry && expiry > new Date();
    res.json({ success: true, data: { isActive, expiresAt: expiry } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to load OnePass status' });
  }
};

/**
 * GET /api/v1/drivers/me/dashboard
 *
 * Aggregated stats for the driver's home screen — earnings, ride counts,
 * rating. Single endpoint so the dashboard makes one round-trip on mount.
 */
export const getMyDashboard = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const driverId = new mongoose.Types.ObjectId(req.user!._id);
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [user, rideCounts, earnings] = await Promise.all([
      User.findById(driverId).select('firstName lastName driverProfile'),
      Ride.aggregate([
        { $match: { driver: driverId } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            today: {
              $sum: {
                $cond: [{ $gte: ['$createdAt', startOfToday] }, 1, 0],
              },
            },
            upcoming: {
              $sum: {
                $cond: [
                  {
                    $in: [
                      '$status',
                      ['searching', 'driver_assigned', 'driver_arriving'],
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),
      Payment.aggregate([
        {
          $match: {
            user: driverId,
            type: 'ride_payment',
            status: 'completed',
          },
        },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
    ]);

    const scheduledRoutes = await Route.find({
      isActive: true,
      type: 'scheduled',
      $or: [
        { 'registeredDrivers.driver': driverId },
        { driver: driverId },
      ],
    }).lean();

    const routesForDriver =
      scheduledRoutes.length > 0 || user?.driverProfile?.serviceType !== 'scheduled'
        ? scheduledRoutes
        : await Route.find({ isActive: true, type: 'scheduled' }).lean();

    let upcomingScheduled = 0;
    for (const r of routesForDriver) {
      const deps = r.schedule?.departures?.length || 0;
      upcomingScheduled += deps * 7;
    }

    const counts = rideCounts[0] || { total: 0, today: 0, upcoming: 0 };
    const totalEarnings = earnings[0]?.total ?? 0;

    res.status(200).json({
      success: true,
      data: {
        driver: {
          firstName: user?.firstName ?? '',
          lastName: user?.lastName ?? '',
          rating: user?.driverProfile?.rating ?? 0,
          isOnline: !!user?.driverProfile?.isOnline,
          serviceType: user?.driverProfile?.serviceType ?? null,
        },
        stats: {
          totalEarnings,
          totalServices: counts.total + upcomingScheduled,
          upcomingServices: counts.upcoming + upcomingScheduled,
          todayServices: counts.today + (routesForDriver.length > 0 ? routesForDriver.reduce((acc, r) => acc + (r.schedule?.departures?.length || 0), 0) : 0),
        },
      },
    });
  } catch (error) {
    console.error('getMyDashboard error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch dashboard' });
  }
};

/**
 * GET /api/v1/drivers/me/earnings
 *
 * Earnings summary for the driver's Earnings screen:
 *   - this-month total + month-over-month growth %
 *   - rides completed this month
 *   - 6-month trend (oldest → newest)
 *   - lifetime breakdown (total / platform fee / fuel allowance / net)
 *
 * Platform fee uses the driver's commissionRate (defaults to 20% if unset).
 * Fuel allowance is currently a flat 12% of total earnings — placeholder
 * until product defines a real rule. Both surface in the breakdown card so
 * the driver knows exactly what was deducted.
 */
export const getMyEarnings = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const driverId = new mongoose.Types.ObjectId(req.user!._id);
    const user = await User.findById(driverId).select(
      'driverProfile.commissionRate driverProfile.rating',
    );
    const commissionPct = user?.driverProfile?.commissionRate ?? 20;
    // Raw rating (0 for a driver nobody has rated yet). The app applies the
    // display rule — show 5 until a real rating exists — so the Earnings
    // header stops rendering an em dash.
    const driverRating = user?.driverProfile?.rating ?? 0;

    const now = new Date();
    const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    // 6-month bucket boundaries (oldest-first). Each entry is the first day
    // of the month — the aggregation pipeline groups payments by month.
    const trendBoundaries: { label: string; start: Date; end: Date }[] = [];
    for (let i = 5; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      const label = start.toLocaleString('en-US', { month: 'short' });
      trendBoundaries.push({ label, start, end });
    }

    const [lifetimeAgg, thisMonthAgg, lastMonthAgg, monthlyAgg, ridesThisMonthCount] =
      await Promise.all([
        Payment.aggregate([
          {
            $match: {
              user: driverId,
              type: 'ride_payment',
              status: 'completed',
            },
          },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ]),
        Payment.aggregate([
          {
            $match: {
              user: driverId,
              type: 'ride_payment',
              status: 'completed',
              createdAt: { $gte: startOfThisMonth },
            },
          },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ]),
        Payment.aggregate([
          {
            $match: {
              user: driverId,
              type: 'ride_payment',
              status: 'completed',
              createdAt: { $gte: startOfLastMonth, $lt: startOfThisMonth },
            },
          },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ]),
        Payment.aggregate([
          {
            $match: {
              user: driverId,
              type: 'ride_payment',
              status: 'completed',
              createdAt: { $gte: trendBoundaries[0].start },
            },
          },
          {
            $group: {
              _id: {
                year: { $year: '$createdAt' },
                month: { $month: '$createdAt' },
              },
              total: { $sum: '$amount' },
            },
          },
        ]),
        Ride.countDocuments({
          driver: driverId,
          status: 'completed',
          createdAt: { $gte: startOfThisMonth },
        }),
      ]);

    const totalEarned = lifetimeAgg[0]?.total ?? 0;
    const thisMonth = thisMonthAgg[0]?.total ?? 0;
    const lastMonth = lastMonthAgg[0]?.total ?? 0;

    // Month-over-month growth %. If last month was zero we don't have a
    // baseline, so just say 0% rather than reporting an infinite jump.
    const growthPct =
      lastMonth > 0
        ? Math.round(((thisMonth - lastMonth) / lastMonth) * 100)
        : 0;

    const trend = trendBoundaries.map(({ label, start }) => {
      const hit = monthlyAgg.find(
        (m: any) =>
          m._id.year === start.getFullYear() &&
          m._id.month === start.getMonth() + 1,
      );
      return { label, value: hit?.total ?? 0 };
    });

    // The driver's `ride_payment` rows already store NET earnings (fare −
    // commission + tip) — the same amount credited to their wallet. So
    // `totalEarned` above IS take-home. The previous code treated it as gross
    // and subtracted commission a SECOND time, then added a fabricated 12%
    // "fuel allowance" — numbers that never reconciled with the wallet.
    // Derive the real breakdown from the actual commission rows instead.
    const commissionAgg = await Payment.aggregate([
      { $match: { user: driverId, type: 'commission', status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    const platformFee = Math.round((commissionAgg[0]?.total ?? 0) * 100) / 100;
    const netEarnings = totalEarned; // already net take-home (matches wallet)
    const grossEarnings = Math.round((netEarnings + platformFee) * 100) / 100;
    const fuelAllowance = 0; // removed — was a fabricated inflation of earnings

    // Daily + weekly totals for the Earnings screen's period filter (it only
    // had monthly before). Today = since local midnight; week = last 7 days.
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(startOfToday);
    startOfWeek.setDate(startOfToday.getDate() - 6); // rolling 7-day window
    const periodAgg = async (start: Date) => {
      const agg = await Payment.aggregate([
        {
          $match: {
            user: driverId,
            type: 'ride_payment',
            status: 'completed',
            createdAt: { $gte: start },
          },
        },
        { $group: { _id: null, total: { $sum: '$amount' }, rides: { $sum: 1 } } },
      ]);
      return { total: agg[0]?.total ?? 0, completedRides: agg[0]?.rides ?? 0 };
    };
    const [todayStats, weekStats] = await Promise.all([
      periodAgg(startOfToday),
      periodAgg(startOfWeek),
    ]);

    // Per-period series so the Earnings screen's Daily/Weekly tabs can plot the
    // same bar chart the Monthly tab uses (which plots `trend`). Bucket in
    // server-local time (Asia/Kolkata, no DST) so buckets line up with the
    // startOfToday/startOfWeek boundaries above — avoids $hour/$dayOfWeek UTC
    // skew. One driver's week of ride payments is small, so find + JS-bucket.
    const weekPayments = await Payment.find({
      user: driverId,
      type: 'ride_payment',
      status: 'completed',
      createdAt: { $gte: startOfWeek },
    })
      .select('amount createdAt')
      .lean();

    const weekSeries: { label: string; value: number }[] = [];
    for (let i = 0; i < 7; i++) {
      const day = new Date(startOfWeek);
      day.setDate(startOfWeek.getDate() + i);
      weekSeries.push({ label: day.toLocaleString('en-US', { weekday: 'short' }), value: 0 });
    }
    const hourlySeries = ['12a', '4a', '8a', '12p', '4p', '8p'].map((label) => ({ label, value: 0 }));
    for (const p of weekPayments) {
      const d = new Date(p.createdAt);
      const dayIdx = Math.floor((d.getTime() - startOfWeek.getTime()) / 86400000);
      if (dayIdx >= 0 && dayIdx < 7) weekSeries[dayIdx].value += p.amount;
      if (d >= startOfToday) {
        const bucket = Math.min(5, Math.floor(d.getHours() / 4));
        hourlySeries[bucket].value += p.amount;
      }
    }
    weekSeries.forEach((s) => (s.value = Math.round(s.value)));
    hourlySeries.forEach((s) => (s.value = Math.round(s.value)));

    res.status(200).json({
      success: true,
      data: {
        today: todayStats,
        thisWeek: weekStats,
        thisMonth: {
          total: thisMonth,
          growthPct,
          completedRides: ridesThisMonthCount,
        },
        trend,
        hourlySeries, // Daily tab — today in 4-hour buckets
        weekSeries, // Weekly tab — last 7 days
        rating: driverRating, // Earnings header stat (app shows 5 until rated)

        breakdown: {
          // totalEarned is GROSS (what riders paid) so Gross − Fee = Net
          // reconciles; netEarnings is the wallet-matching take-home.
          totalEarned: grossEarnings,
          platformFee,
          fuelAllowance,
          netEarnings,
          commissionPct,
          fuelPct: 0,
        },
      },
    });
  } catch (error) {
    console.error('getMyEarnings error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch earnings' });
  }
};

/**
 * GET /api/v1/driver/profile
 */
export const getDriverProfile = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await User.findById(req.user!._id);
    if (!user || user.role !== 'driver') {
      res.status(404).json({ success: false, message: 'Driver not found' });
      return;
    }

    res.status(200).json({
      success: true,
      data: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        avatar: user.avatar,
        driverProfile: user.driverProfile,
        createdAt: user.createdAt,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch profile' });
  }
};

/**
 * PUT /api/v1/driver/saved-addresses (Customer)
 *
 * Replaces the entire `savedAddresses` array. Ensures at most one address is
 * marked `isPrimary` — if the client sets multiple, only the first wins; if
 * none are flagged but the user previously had a primary, we promote the first
 * one so there's always a sensible default.
 */
export const updateSavedAddresses = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { addresses } = req.body;
    if (!Array.isArray(addresses)) {
      res.status(400).json({ success: false, message: 'addresses must be an array' });
      return;
    }

    let primaryAssigned = false;
    const sanitized = addresses.map((a) => {
      const isPrimary = !!a.isPrimary && !primaryAssigned;
      if (isPrimary) primaryAssigned = true;
      return { ...a, isPrimary };
    });

    if (!primaryAssigned && sanitized.length > 0) {
      sanitized[0].isPrimary = true;
    }

    const user = await User.findByIdAndUpdate(
      req.user!._id,
      { savedAddresses: sanitized },
      { new: true }
    );

    res.status(200).json({
      success: true,
      data: { savedAddresses: user?.savedAddresses },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update addresses' });
  }
};

/**
 * PATCH /api/v1/drivers/saved-addresses/:index/primary (Customer)
 *
 * Marks the address at the given index as primary and clears the flag on every
 * other saved address. Cheaper round-trip than re-PUTing the whole array.
 */
export const setPrimaryAddress = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const target = parseInt(req.params.index, 10);
    if (Number.isNaN(target) || target < 0) {
      res.status(400).json({ success: false, message: 'Invalid address index' });
      return;
    }

    const user = await User.findById(req.user!._id);
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }
    if (!user.savedAddresses || target >= user.savedAddresses.length) {
      res.status(404).json({ success: false, message: 'Address not found' });
      return;
    }

    user.savedAddresses = user.savedAddresses.map((addr, idx) => ({
      ...((addr as any).toObject?.() ?? addr),
      isPrimary: idx === target,
    })) as any;
    await user.save();

    res.status(200).json({
      success: true,
      data: { savedAddresses: user.savedAddresses },
    });
  } catch (error) {
    console.error('setPrimaryAddress error:', error);
    res.status(500).json({ success: false, message: 'Failed to set primary address' });
  }
};
