import { Router } from 'express';
import {
  toggleOnline,
  updateLocation,
  getNearbyDrivers,
  subscribeOnePass,
  getDriverProfile,
  getMyDashboard,
  getMyEarnings,
  updateSavedAddresses,
  setPrimaryAddress,
  updateRegistrationStep,
} from '../controllers/driverController';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { DriverIncentive, DriverIncentiveProgress } from '../models/DriverIncentive';
import { periodKeyFor } from '../services/incentivesEngine';

const router = Router();
router.use(authenticate);

// ── Registration funnel (no role check — promotes customer → driver) ──
router.put('/registration/step', updateRegistrationStep);

// ── Driver-specific ──
router.put('/toggle-online', authorize('driver'), toggleOnline);
router.put('/location', authorize('driver'), updateLocation);
router.get('/profile', authorize('driver'), getDriverProfile);
router.get('/me/dashboard', authorize('driver'), getMyDashboard);
router.get('/me/earnings', authorize('driver'), getMyEarnings);
router.post('/onepass/subscribe', authorize('driver'), subscribeOnePass);

// ── Driver incentives (own view) ──
router.get('/incentives', authorize('driver'), async (req: AuthRequest, res) => {
  try {
    const now = new Date();
    const drvId = req.user!._id;
    const dp: any = req.user?.driverProfile ?? {};
    const drvVehicle: string | undefined = dp.vehicleType ?? dp.vehicleMake;
    const drvRating: number = dp.rating ?? 0;

    const rules = await DriverIncentive.find({
      active: true,
      $and: [
        { $or: [{ startDate: { $exists: false } }, { startDate: null }, { startDate: { $lte: now } }] },
        { $or: [{ endDate: { $exists: false } }, { endDate: null }, { endDate: { $gte: now } }] },
      ],
    }).lean();

    const eligible = rules.filter((r) => {
      if (r.minRating && drvRating < r.minRating) return false;
      if (r.vehicleTypes && r.vehicleTypes.length > 0 && drvVehicle && !r.vehicleTypes.includes(drvVehicle)) return false;
      if (r.driverIds && r.driverIds.length > 0 && !r.driverIds.some((d) => String(d) === String(drvId))) return false;
      return true;
    });

    const items = await Promise.all(
      eligible.map(async (r) => {
        const { key } = periodKeyFor(r.period, now);
        const progress = await DriverIncentiveProgress.findOne({
          incentive: r._id,
          driver: drvId,
          periodKey: key,
        }).lean();
        return { incentive: r, progress };
      })
    );

    res.json({ success: true, data: { items } });
  } catch (err) {
    console.error('[Driver Incentives] error:', err);
    res.status(500).json({ success: false, message: 'Failed' });
  }
});

router.get('/incentives/history', authorize('driver'), async (req: AuthRequest, res) => {
  try {
    const items = await DriverIncentiveProgress.find({ driver: req.user!._id })
      .populate('incentive', 'name period target threshold rewardType rewardAmount')
      .sort({ periodStart: -1 })
      .limit(100)
      .lean();
    res.json({ success: true, data: { items } });
  } catch (err) {
    console.error('[Driver Incentives History] error:', err);
    res.status(500).json({ success: false, message: 'Failed' });
  }
});

// ── Customer can search nearby drivers ──
router.get('/nearby', getNearbyDrivers);

// ── Saved addresses (customer) ──
router.put('/saved-addresses', updateSavedAddresses);
router.patch('/saved-addresses/:index/primary', setPrimaryAddress);

export default router;

