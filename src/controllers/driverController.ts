import { Response } from 'express';
import mongoose from 'mongoose';
import { User, Ride, Payment } from '../models';
import { AuthRequest } from '../middleware/auth';

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

    // Filter by distance (simplified)
    const nearbyDrivers = drivers.filter((driver) => {
      if (!driver.driverProfile?.currentLocation) return false;
      const dLat = driver.driverProfile.currentLocation.lat - lat;
      const dLng = driver.driverProfile.currentLocation.lng - lng;
      const dist = Math.sqrt(dLat ** 2 + dLng ** 2) * 111; // rough km
      return dist <= radiusKm;
    });

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
 * POST /api/v1/driver/onepass/subscribe
 */
export const subscribeOnePass = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { plan } = req.body; // weekly | monthly | annual
    const durations: Record<string, number> = {
      weekly: 7,
      monthly: 30,
      annual: 365,
    };

    const days = durations[plan] || 30;
    const expiry = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    await User.findByIdAndUpdate(req.user!._id, {
      'driverProfile.isOnePass': true,
      'driverProfile.onePassExpiry': expiry,
    });

    res.status(200).json({
      success: true,
      message: 'One Pass subscription activated',
      data: { plan, expiresAt: expiry },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Subscription failed' });
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
          totalServices: counts.total,
          upcomingServices: counts.upcoming,
          todayServices: counts.today,
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
    const user = await User.findById(driverId).select('driverProfile.commissionRate');
    const commissionPct = user?.driverProfile?.commissionRate ?? 20;
    const fuelPct = 12;

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

    const platformFee = Math.round((totalEarned * commissionPct) / 100);
    const fuelAllowance = Math.round((totalEarned * fuelPct) / 100);
    const netEarnings = totalEarned - platformFee + fuelAllowance;

    res.status(200).json({
      success: true,
      data: {
        thisMonth: {
          total: thisMonth,
          growthPct,
          completedRides: ridesThisMonthCount,
        },
        trend,
        breakdown: {
          totalEarned,
          platformFee,
          fuelAllowance,
          netEarnings,
          commissionPct,
          fuelPct,
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
