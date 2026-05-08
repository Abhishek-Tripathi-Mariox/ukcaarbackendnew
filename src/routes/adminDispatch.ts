import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { User, Ride } from '../models';
import { requirePermission } from '../middleware/auth';
import { auditLog } from '../middleware/audit';
import { PERMISSIONS } from '../config/permissions';
import { emitToUser } from '../socket';

const router = Router();

const ACTIVE_RIDE_STATUSES = [
  'searching',
  'driver_assigned',
  'driver_arriving',
  'driver_arrived',
  'in_progress',
];

/** Haversine distance in km */
function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * GET /api/v1/admin/dispatch/online-drivers
 * All currently online drivers with location for the live map.
 */
router.get(
  '/dispatch/online-drivers',
  requirePermission(PERMISSIONS.MANAGE_RIDES, PERMISSIONS.VIEW_DASHBOARD),
  async (_req: Request, res: Response) => {
    try {
      const drivers = await User.find({
        role: 'driver',
        isActive: true,
        'driverProfile.isOnline': true,
        'driverProfile.currentLocation.lat': { $ne: null },
      })
        .select(
          '_id firstName lastName phone avatar driverProfile.currentLocation driverProfile.vehicleMake driverProfile.vehicleModel driverProfile.plateNumber driverProfile.rating driverProfile.isOnePass'
        )
        .lean();

      // Find each driver's active ride (if any)
      const driverIds = drivers.map((d) => d._id);
      const activeRides = await Ride.find({
        driver: { $in: driverIds },
        status: { $in: ACTIVE_RIDE_STATUSES },
      })
        .select('_id driver status pickup dropoff customer')
        .lean();

      const ridesByDriver = new Map<string, any>();
      activeRides.forEach((r) => {
        if (r.driver) ridesByDriver.set(r.driver.toString(), r);
      });

      const result = drivers.map((d) => ({
        _id: d._id,
        name: `${d.firstName || ''} ${d.lastName || ''}`.trim(),
        phone: d.phone,
        avatar: d.avatar,
        location: d.driverProfile?.currentLocation,
        vehicle: d.driverProfile
          ? {
              make: d.driverProfile.vehicleMake,
              model: d.driverProfile.vehicleModel,
              plate: d.driverProfile.plateNumber,
            }
          : null,
        rating: d.driverProfile?.rating,
        isOnePass: d.driverProfile?.isOnePass,
        activeRide: ridesByDriver.get(d._id.toString()) || null,
        busy: ridesByDriver.has(d._id.toString()),
      }));

      res.status(200).json({
        success: true,
        data: {
          drivers: result,
          total: result.length,
          available: result.filter((d) => !d.busy).length,
          busy: result.filter((d) => d.busy).length,
        },
      });
    } catch (error) {
      console.error('[Dispatch] online-drivers error:', error);
      res.status(500).json({ success: false, message: 'Failed to fetch online drivers' });
    }
  }
);

/**
 * GET /api/v1/admin/dispatch/nearby/:rideId
 * List online available drivers near a ride's pickup, sorted by distance.
 * Query: radius (km, default 10), limit (default 20)
 */
router.get(
  '/dispatch/nearby/:rideId',
  requirePermission(PERMISSIONS.MANAGE_RIDES),
  async (req: Request, res: Response) => {
    try {
      const { rideId } = req.params;
      const radiusKm = Math.min(parseFloat(req.query.radius as string) || 10, 50);
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

      if (!mongoose.isValidObjectId(rideId)) {
        res.status(400).json({ success: false, message: 'Invalid ride id' });
        return;
      }

      const ride = await Ride.findById(rideId).select('pickup driver status rideType').lean();
      if (!ride) {
        res.status(404).json({ success: false, message: 'Ride not found' });
        return;
      }

      const drivers = await User.find({
        role: 'driver',
        isActive: true,
        'driverProfile.isOnline': true,
        'driverProfile.currentLocation.lat': { $ne: null },
        ...(ride.driver ? { _id: { $ne: ride.driver } } : {}),
      })
        .select(
          '_id firstName lastName phone avatar driverProfile.currentLocation driverProfile.vehicleMake driverProfile.vehicleModel driverProfile.plateNumber driverProfile.rating driverProfile.isOnePass'
        )
        .lean();

      // Exclude drivers currently in another active ride
      const onlineIds = drivers.map((d) => d._id);
      const busy = await Ride.find({
        driver: { $in: onlineIds },
        status: { $in: ACTIVE_RIDE_STATUSES },
      })
        .select('driver')
        .lean();
      const busyIds = new Set(busy.map((r) => r.driver?.toString()));

      const enriched = drivers
        .filter((d) => !busyIds.has(d._id.toString()))
        .filter((d) => d.driverProfile?.currentLocation?.lat != null)
        .map((d) => {
          const loc = d.driverProfile!.currentLocation!;
          const distanceKm = haversineKm(
            { lat: ride.pickup.lat, lng: ride.pickup.lng },
            { lat: loc.lat, lng: loc.lng }
          );
          // Rough ETA at 30km/h average city speed
          const etaMin = Math.round((distanceKm / 30) * 60);
          return {
            _id: d._id,
            name: `${d.firstName || ''} ${d.lastName || ''}`.trim(),
            phone: d.phone,
            avatar: d.avatar,
            location: loc,
            vehicle: d.driverProfile
              ? {
                  make: d.driverProfile.vehicleMake,
                  model: d.driverProfile.vehicleModel,
                  plate: d.driverProfile.plateNumber,
                }
              : null,
            rating: d.driverProfile?.rating,
            isOnePass: d.driverProfile?.isOnePass,
            distanceKm: Number(distanceKm.toFixed(2)),
            etaMin,
          };
        })
        .filter((d) => d.distanceKm <= radiusKm)
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, limit);

      res.status(200).json({
        success: true,
        data: {
          rideId,
          pickup: ride.pickup,
          radiusKm,
          drivers: enriched,
          count: enriched.length,
        },
      });
    } catch (error) {
      console.error('[Dispatch] nearby error:', error);
      res.status(500).json({ success: false, message: 'Failed to fetch nearby drivers' });
    }
  }
);

/**
 * POST /api/v1/admin/dispatch/:rideId/assign
 * Manually assign a driver to a ride (typically when stuck in `searching`).
 * Body: { driverId, reason? }
 */
router.post(
  '/dispatch/:rideId/assign',
  requirePermission(PERMISSIONS.MANAGE_RIDES),
  auditLog({ action: 'dispatch.assign', resourceType: 'Ride', resourceId: (req) => req.params.rideId }),
  async (req: Request, res: Response) => {
    try {
      const { rideId } = req.params;
      const { driverId, reason } = req.body;

      if (!mongoose.isValidObjectId(rideId) || !mongoose.isValidObjectId(driverId)) {
        res.status(400).json({ success: false, message: 'Invalid ride or driver id' });
        return;
      }

      const [ride, driver] = await Promise.all([
        Ride.findById(rideId),
        User.findOne({ _id: driverId, role: 'driver', isActive: true }),
      ]);

      if (!ride) {
        res.status(404).json({ success: false, message: 'Ride not found' });
        return;
      }
      if (!driver) {
        res.status(404).json({ success: false, message: 'Driver not found' });
        return;
      }
      if (['completed', 'cancelled'].includes(ride.status)) {
        res.status(400).json({ success: false, message: 'Cannot assign completed/cancelled ride' });
        return;
      }
      if (!driver.driverProfile?.isOnline) {
        res.status(400).json({ success: false, message: 'Driver is offline' });
        return;
      }

      // Reject if driver already on another active ride
      const existing = await Ride.findOne({
        driver: driver._id,
        _id: { $ne: ride._id },
        status: { $in: ACTIVE_RIDE_STATUSES },
      }).select('_id');
      if (existing) {
        res.status(409).json({ success: false, message: 'Driver is already on an active ride' });
        return;
      }

      const previousDriverId = ride.driver?.toString();
      ride.driver = driver._id as any;
      if (ride.status === 'searching') ride.status = 'driver_assigned';
      await ride.save();

      // Notify previous driver if any (reassign)
      if (previousDriverId && previousDriverId !== driver._id.toString()) {
        emitToUser(previousDriverId, 'ride:reassigned', {
          rideId: ride._id,
          reason,
          message: 'Ride was reassigned by admin.',
        });
      }

      // Notify new driver
      emitToUser(driver._id.toString(), 'ride:assigned', {
        rideId: ride._id,
        pickup: ride.pickup,
        dropoff: ride.dropoff,
        fare: ride.estimatedFare,
        message: 'You have been assigned a new ride by admin.',
      });

      // Notify customer
      emitToUser(ride.customer.toString(), 'ride:driver-changed', {
        rideId: ride._id,
        driver: {
          name: `${driver.firstName} ${driver.lastName}`,
          phone: driver.phone,
          vehicle: driver.driverProfile,
        },
        message: 'A driver has been assigned to your ride.',
      });

      res.status(200).json({
        success: true,
        data: { ride },
        message: 'Driver assigned',
      });
    } catch (error) {
      console.error('[Dispatch] assign error:', error);
      res.status(500).json({ success: false, message: 'Assignment failed' });
    }
  }
);

export default router;
