import { Request, Response } from 'express';
import { validationResult } from 'express-validator';
import { Ride, User, Wallet, Payment, PromoCode } from '../models';
import { config } from '../config';
import { AuthRequest } from '../middleware/auth';
import { processRideForIncentives } from '../services/incentivesEngine';
import { awardPointsForRide } from '../services/loyaltyEngine';
import { safeResolveSurge, isPickupBlocked } from '../services/surge';

/**
 * Helper: Calculate fare
 */
const calculateFare = (
  rideType: keyof typeof config.ride.baseFares,
  distanceKm: number,
  durationMin: number,
  promoDiscount: number = 0
) => {
  const fare = config.ride.baseFares[rideType];
  const baseFare = fare.base;
  const distanceFare = fare.perKm * distanceKm;
  const timeFare = fare.perMin * durationMin;
  const subtotal = baseFare + distanceFare + timeFare;
  const discount = Math.min(promoDiscount, subtotal * 0.5); // Max 50% discount
  const total = Math.max(subtotal - discount, fare.base); // Min = base fare
  return {
    baseFare: Math.round(baseFare * 100) / 100,
    distanceFare: Math.round(distanceFare * 100) / 100,
    timeFare: Math.round(timeFare * 100) / 100,
    discount: Math.round(discount * 100) / 100,
    total: Math.round(total * 100) / 100,
  };
};

/**
 * POST /api/v1/rides/estimate
 * Get fare estimate for a ride
 */
export const estimateFare = async (req: Request, res: Response): Promise<void> => {
  try {
    const { pickup, dropoff, rideType = 'economy' } = req.body;

    if (!pickup?.lat || !pickup?.lng || !dropoff?.lat || !dropoff?.lng) {
      res.status(400).json({ success: false, message: 'Pickup and dropoff coordinates required' });
      return;
    }

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
    const distance = R * c;
    const duration = distance * 3; // rough estimate: 3 min per km

    // Calculate fares for all ride types
    const rideTypes = Object.keys(config.ride.baseFares) as (keyof typeof config.ride.baseFares)[];
    // Resolve surge once for the pickup point — same surge applied to every variant.
    const baselineSubtotal = (config.ride.baseFares.economy.base) +
      (config.ride.baseFares.economy.perKm * distance) +
      (config.ride.baseFares.economy.perMin * duration);
    const surge = await safeResolveSurge(pickup.lat, pickup.lng, baselineSubtotal);

    const estimates = rideTypes.map((type) => {
      const fare = calculateFare(type, distance, duration);
      const subtotal = fare.baseFare + fare.distanceFare + fare.timeFare;
      const surgeAmount =
        Math.round((subtotal * (surge.multiplier - 1) + surge.flatSurcharge) * 100) / 100;
      const total = Math.round((fare.total + surgeAmount) * 100) / 100;
      return {
        rideType: type,
        estimatedFare: total,
        baseFare: fare.baseFare,
        distanceFare: fare.distanceFare,
        timeFare: fare.timeFare,
        surgeFare: surgeAmount,
        surgeMultiplier: surge.multiplier,
        estimatedDistance: Math.round(distance * 10) / 10,
        estimatedDuration: Math.round(duration),
      };
    });

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
      promoCode, isScheduled, scheduledAt, isPrivate,
    } = req.body;

    // Calculate fare
    const R = 6371;
    const dLat = ((dropoff.lat - pickup.lat) * Math.PI) / 180;
    const dLng = ((dropoff.lng - pickup.lng) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((pickup.lat * Math.PI) / 180) *
        Math.cos((dropoff.lat * Math.PI) / 180) *
        Math.sin(dLng / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = R * c;
    const duration = distance * 3;

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
        const fare = calculateFare(rideType, distance, duration);
        if (fare.total >= promo.minFare) {
          promoDiscount =
            promo.type === 'percentage'
              ? Math.min((fare.total * promo.value) / 100, promo.maxDiscount)
              : Math.min(promo.value, promo.maxDiscount);
          await PromoCode.findByIdAndUpdate(promo._id, { $inc: { usedCount: 1 } });
        }
      }
    }

    const fare = calculateFare(rideType, distance, duration, promoDiscount);

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
    const totalWithSurge = Math.round((fare.total + surge.surgeAmount) * 100) / 100;

    const ride = await Ride.create({
      customer: req.user!._id,
      rideType,
      pickup,
      dropoff,
      stops,
      estimatedDistance: Math.round(distance * 10) / 10,
      estimatedDuration: Math.round(duration),
      estimatedFare: totalWithSurge,
      baseFare: fare.baseFare,
      distanceFare: fare.distanceFare,
      timeFare: fare.timeFare,
      surgeFare: surge.surgeAmount,
      discount: fare.discount,
      paymentMethod: paymentMethod || 'card',
      promoCode,
      isScheduled: isScheduled || false,
      scheduledAt,
      isPrivate: isPrivate || false,
      status: 'searching',
    });

    // In production, emit to nearby drivers via Socket.IO
    // io.to(`drivers:${rideType}`).emit('new_ride_request', ride);

    res.status(201).json({
      success: true,
      message: 'Ride request created',
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

    res.status(200).json({ success: true, data: { ride } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch ride' });
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
    if (req.user?.role === 'customer') {
      filter.customer = req.user._id;
    } else if (req.user?.role === 'driver') {
      filter.driver = req.user._id;
    }

    if (req.query.status) {
      filter.status = req.query.status;
    }

    const [rides, total] = await Promise.all([
      Ride.find(filter)
        .populate('customer', 'firstName lastName avatar')
        .populate('driver', 'firstName lastName avatar driverProfile.rating')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Ride.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: {
        rides,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch rides' });
  }
};

/**
 * PUT /api/v1/rides/:id/accept  (Driver)
 */
export const acceptRide = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const ride = await Ride.findById(req.params.id);
    if (!ride || ride.status !== 'searching') {
      res.status(400).json({ success: false, message: 'Ride not available' });
      return;
    }

    ride.driver = req.user!._id;
    ride.status = 'driver_assigned';
    await ride.save();

    // Notify customer
    // io.to(`user:${ride.customer}`).emit('ride_accepted', { ride, driver: req.user });

    res.status(200).json({ success: true, data: { ride } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to accept ride' });
  }
};

/**
 * PUT /api/v1/rides/:id/status  (Driver)
 * Update ride status progression
 */
export const updateRideStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { status } = req.body;
    const validTransitions: Record<string, string[]> = {
      driver_assigned: ['driver_arriving'],
      driver_arriving: ['driver_arrived'],
      driver_arrived: ['in_progress'],
      in_progress: ['completed'],
    };

    const ride = await Ride.findById(req.params.id);
    if (!ride) {
      res.status(404).json({ success: false, message: 'Ride not found' });
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
    if (status === 'completed') {
      ride.completedAt = new Date();
      ride.actualFare = ride.estimatedFare; // In production, recalculate
      ride.actualDistance = ride.estimatedDistance;
      ride.actualDuration = ride.estimatedDuration;

      // Calculate commission + driver earnings
      const isOnePass = req.user?.driverProfile?.isOnePass;
      const commissionRate = isOnePass
        ? config.ride.onePassCommissionRate
        : config.ride.commissionRate;
      ride.commission = Math.round(ride.actualFare * commissionRate * 100) / 100;
      ride.driverEarnings = Math.round((ride.actualFare - ride.commission + ride.tip) * 100) / 100;
      ride.paymentStatus = 'completed';

      // Update driver stats
      await User.findByIdAndUpdate(ride.driver, {
        $inc: {
          'driverProfile.totalTrips': 1,
          'driverProfile.totalEarnings': ride.driverEarnings,
        },
      });

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
    }

    await ride.save();

    // Run incentives engine asynchronously on ride completion
    if (status === 'completed') {
      processRideForIncentives(ride).catch((err) =>
        console.error('[incentives] processRideForIncentives failed:', err)
      );
      awardPointsForRide(ride).catch((err) =>
        console.error('[loyalty] awardPointsForRide failed:', err)
      );
    }

    // io.to(`ride:${ride._id}`).emit('ride_status_updated', { status, ride });

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

    const cancelledBy = req.user?.role === 'driver' ? 'driver' : 'customer';
    const hasFee = ['driver_arriving', 'driver_arrived', 'in_progress'].includes(ride.status);
    const fee = hasFee ? config.ride.cancellationFee : 0;

    ride.status = 'cancelled';
    ride.cancellation = {
      cancelledBy,
      reason: reason || 'No reason provided',
      fee,
      cancelledAt: new Date(),
    };
    await ride.save();

    // Create cancellation fee payment if applicable
    if (fee > 0) {
      await Payment.create({
        user: ride.customer,
        ride: ride._id,
        type: 'cancellation_fee',
        amount: fee,
        method: ride.paymentMethod,
        status: 'completed',
        description: `Cancellation fee for ride`,
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
    ride.actualDuration = ride.estimatedDuration;
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

    if (!ride || ride.status !== 'completed') {
      res.status(400).json({ success: false, message: 'Ride not found or not completed' });
      return;
    }

    const isCustomer = ride.customer.toString() === req.user?._id.toString();

    if (!ride.rating) {
      ride.rating = {} as any;
    }

    if (isCustomer) {
      ride.rating!.customerToDriver = rating;
      ride.rating!.customerComment = comment;
      ride.rating!.tags = tags;

      // Handle tip
      if (tip && tip > 0) {
        ride.tip = tip;
        ride.driverEarnings += tip;
        await ride.save();

        await Payment.create({
          user: ride.customer,
          ride: ride._id,
          type: 'tip',
          amount: tip,
          method: ride.paymentMethod,
          status: 'completed',
          description: 'Driver tip',
        });

        await User.findByIdAndUpdate(ride.driver, {
          $inc: { 'driverProfile.totalEarnings': tip },
        });
      }

      // Update driver rating (running average)
      if (ride.driver) {
        const driverRides = await Ride.find({
          driver: ride.driver,
          'rating.customerToDriver': { $exists: true },
        }).select('rating.customerToDriver');

        const avgRating =
          driverRides.reduce((sum, r) => sum + (r.rating?.customerToDriver || 0), 0) /
          driverRides.length;

        await User.findByIdAndUpdate(ride.driver, {
          'driverProfile.rating': Math.round(avgRating * 100) / 100,
        });
      }
    } else {
      ride.rating!.driverToCustomer = rating;
      ride.rating!.driverComment = comment;
    }

    await ride.save();
    res.status(200).json({ success: true, message: 'Rating submitted', data: { ride } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Rating failed' });
  }
};
