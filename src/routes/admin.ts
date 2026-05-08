import { Router, Request, Response } from 'express';
import { User, Ride, Payment, Wallet, Chat, PromoCode, Notification } from '../models';
import { sendPushToTokens } from '../config/firebase';
import { authenticate, authorize, requirePermission } from '../middleware/auth';
import { auditLog } from '../middleware/audit';
import { PERMISSIONS } from '../config/permissions';
import { emitToUser } from '../socket';
import { config } from '../config';
import governanceRouter from './adminGovernance';
import dispatchRouter from './adminDispatch';
import financeRouter from './adminFinance';
import supportRouter from './adminSupport';
import reportsRouter from './adminReports';
import incentivesRouter from './adminIncentives';
import loyaltyRouter from './adminLoyalty';
import zonesRouter from './adminZones';
import routesRouter from './adminRoutes';
import notificationTemplatesRouter from './adminNotificationTemplates';
import driversRouter from './adminDrivers';
import vehicleTypesRouter from './adminVehicleTypes';

const router = Router();
router.use(authenticate);
router.use(authorize('admin'));

// Driver management additions (mounted before legacy inline routes so the
// new `POST /drivers/:id/...` aliases and paginated `/drivers/:id/rides`
// take precedence).
router.use('/', driversRouter);

// RBAC governance + audit log endpoints (mounted under /admin)
router.use('/', governanceRouter);
// Live dispatch (online drivers, nearby search, manual assign)
router.use('/', dispatchRouter);
// Finance (settlements / invoicing)
router.use('/', financeRouter);
// Support ticketing
router.use('/', supportRouter);
// Heatmap + CSV exports
router.use('/', reportsRouter);
// Driver incentives
router.use('/', incentivesRouter);
// Customer loyalty
router.use('/', loyaltyRouter);
// Zones + surge
router.use('/', zonesRouter);
// Routes (private + scheduled / shuttle rides)
router.use('/', routesRouter);
// Notification templates
router.use('/', notificationTemplatesRouter);
// Vehicle + fuel types catalogue
router.use('/', vehicleTypesRouter);

// ════════════════════════════════════════════════════════════════════
// DASHBOARD & ANALYTICS
// ════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/admin/dashboard
 * Enhanced dashboard with comprehensive metrics
 */
router.get('/dashboard', async (_req: Request, res: Response) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      totalDrivers,
      verifiedDrivers,
      pendingDrivers,
      totalRides,
      activeRides,
      completedRides,
      cancelledRides,
      todayRides,
      weekRides,
      totalRevenue,
      todayRevenue,
      weekRevenue,
      onlineDrivers,
      onePassDrivers,
      activePromos,
      totalWalletBalance,
    ] = await Promise.all([
      User.countDocuments({ role: 'customer' }),
      User.countDocuments({ role: 'driver' }),
      User.countDocuments({ role: 'driver', 'driverProfile.registrationStep': 'approved' }),
      User.countDocuments({ role: 'driver', 'driverProfile.registrationStep': { $ne: 'approved' } }),
      Ride.countDocuments(),
      Ride.countDocuments({ status: { $in: ['searching', 'driver_assigned', 'driver_arriving', 'driver_arrived', 'in_progress'] } }),
      Ride.countDocuments({ status: 'completed' }),
      Ride.countDocuments({ status: 'cancelled' }),
      Ride.countDocuments({ createdAt: { $gte: today } }),
      Ride.countDocuments({ createdAt: { $gte: weekAgo } }),
      Payment.aggregate([
        { $match: { status: 'completed', type: 'ride_payment' } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Payment.aggregate([
        { $match: { status: 'completed', type: 'ride_payment', createdAt: { $gte: today } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Payment.aggregate([
        { $match: { status: 'completed', type: 'ride_payment', createdAt: { $gte: weekAgo } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      User.countDocuments({ role: 'driver', 'driverProfile.isOnline': true }),
      User.countDocuments({ role: 'driver', 'driverProfile.isOnePass': true }),
      PromoCode.countDocuments({ isActive: true, expiresAt: { $gt: new Date() } }),
      Wallet.aggregate([{ $group: { _id: null, total: { $sum: '$balance' } } }]),
    ]);

    // Calculate average rating
    const avgDriverRating = await User.aggregate([
      { $match: { role: 'driver', 'driverProfile.rating': { $gt: 0 } } },
      { $group: { _id: null, avg: { $avg: '$driverProfile.rating' } } },
    ]);

    res.status(200).json({
      success: true,
      data: {
        customers: { total: totalUsers },
        drivers: {
          total: totalDrivers,
          verified: verifiedDrivers,
          pending: pendingDrivers,
          online: onlineDrivers,
          onePass: onePassDrivers,
          averageRating: avgDriverRating[0]?.avg?.toFixed(2) || 0,
        },
        rides: {
          total: totalRides,
          active: activeRides,
          completed: completedRides,
          cancelled: cancelledRides,
          today: todayRides,
          thisWeek: weekRides,
          completionRate: totalRides > 0 ? ((completedRides / totalRides) * 100).toFixed(1) : 0,
        },
        revenue: {
          total: totalRevenue[0]?.total || 0,
          today: todayRevenue[0]?.total || 0,
          thisWeek: weekRevenue[0]?.total || 0,
          currency: 'INR',
        },
        promos: { active: activePromos },
        wallets: { totalBalance: totalWalletBalance[0]?.total || 0 },
      },
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ success: false, message: 'Dashboard fetch failed' });
  }
});

/**
 * GET /api/v1/admin/analytics/rides
 * Ride analytics with date range and grouping
 */
router.get('/analytics/rides', async (req: Request, res: Response) => {
  try {
    const { startDate, endDate, groupBy = 'day' } = req.query;
    const start = startDate ? new Date(startDate as string) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate as string) : new Date();

    const dateFormat = groupBy === 'hour' ? '%Y-%m-%d %H:00' : groupBy === 'month' ? '%Y-%m' : '%Y-%m-%d';

    const analytics = await Ride.aggregate([
      { $match: { createdAt: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: { $dateToString: { format: dateFormat, date: '$createdAt' } },
          total: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
          revenue: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$actualFare', 0] } },
          avgFare: { $avg: { $cond: [{ $eq: ['$status', 'completed'] }, '$actualFare', null] } },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const rideTypeBreakdown = await Ride.aggregate([
      { $match: { createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: '$rideType', count: { $sum: 1 }, revenue: { $sum: '$actualFare' } } },
    ]);

    const peakHours = await Ride.aggregate([
      { $match: { createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: { $hour: '$createdAt' }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 },
    ]);

    res.status(200).json({
      success: true,
      data: { analytics, rideTypeBreakdown, peakHours, dateRange: { start, end } },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Analytics fetch failed' });
  }
});

/**
 * GET /api/v1/admin/analytics/revenue
 * Revenue analytics
 */
router.get('/analytics/revenue', async (req: Request, res: Response) => {
  try {
    const { startDate, endDate } = req.query;
    const start = startDate ? new Date(startDate as string) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate as string) : new Date();

    const revenueByDay = await Payment.aggregate([
      { $match: { status: 'completed', type: 'ride_payment', createdAt: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          revenue: { $sum: '$amount' },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const revenueByMethod = await Payment.aggregate([
      { $match: { status: 'completed', type: 'ride_payment', createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: '$method', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]);

    const commissionEarned = await Ride.aggregate([
      { $match: { status: 'completed', createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: null, total: { $sum: '$commission' } } },
    ]);

    res.status(200).json({
      success: true,
      data: {
        revenueByDay,
        revenueByMethod,
        commissionEarned: commissionEarned[0]?.total || 0,
        dateRange: { start, end },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Revenue analytics failed' });
  }
});

// ════════════════════════════════════════════════════════════════════
// USER MANAGEMENT (Customers)
// ════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/admin/users
 * List users with advanced filters
 */
router.get('/users', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const { role, isActive, isVerified, search, sortBy, sortOrder } = req.query;

    const filter: Record<string, any> = {};
    if (role) filter.role = role;
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    if (isVerified !== undefined) filter.isVerified = isVerified === 'true';
    if (search) {
      filter.$or = [
        { firstName: { $regex: search, $options: 'i' } },
        { lastName: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
      ];
    }

    const sortField = (sortBy as string) || 'createdAt';
    const sortDir = sortOrder === 'asc' ? 1 : -1;

    const [users, total] = await Promise.all([
      User.find(filter)
        .sort({ [sortField]: sortDir })
        .skip((page - 1) * limit)
        .limit(limit),
      User.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: { users, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch users' });
  }
});

/**
 * GET /api/v1/admin/users/:id
 * Get single user with full details, rides, payments
 */
router.get('/users/:id', async (req: Request, res: Response) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    const userId = user._id;
    const isDriver = user.role === 'driver';
    const rideMatch = isDriver ? { driver: userId } : { customer: userId };
    const thirty = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
    sixMonthsAgo.setDate(1);
    sixMonthsAgo.setHours(0, 0, 0, 0);

    const [
      rides,
      payments,
      wallet,
      rideStats,
      ridesByStatus,
      ridesByMonth,
      paymentStats,
      paymentsByMethod,
      last30,
    ] = await Promise.all([
      Ride.find(rideMatch)
        .populate('customer', 'firstName lastName phone avatar')
        .populate('driver', 'firstName lastName phone avatar')
        .sort({ createdAt: -1 })
        .limit(20),
      Payment.find({ user: userId }).sort({ createdAt: -1 }).limit(20),
      Wallet.findOne({ user: userId }),
      Ride.aggregate([
        { $match: rideMatch },
        {
          $group: {
            _id: null,
            totalRides: { $sum: 1 },
            completedRides: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            cancelledRides: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
            totalSpent: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, { $ifNull: ['$actualFare', 0] }, 0] } },
            totalDistanceKm: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, { $ifNull: ['$distance', 0] }, 0] } },
            avgFare: { $avg: { $cond: [{ $eq: ['$status', 'completed'] }, '$actualFare', null] } },
          },
        },
      ]),
      Ride.aggregate([
        { $match: rideMatch },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      Ride.aggregate([
        { $match: { ...rideMatch, createdAt: { $gte: sixMonthsAgo } } },
        {
          $group: {
            _id: { y: { $year: '$createdAt' }, m: { $month: '$createdAt' } },
            count: { $sum: 1 },
            spent: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, { $ifNull: ['$actualFare', 0] }, 0] } },
          },
        },
        { $sort: { '_id.y': 1, '_id.m': 1 } },
      ]),
      Payment.aggregate([
        { $match: { user: userId } },
        {
          $group: {
            _id: null,
            totalPaid: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$amount', 0] } },
            totalRefunded: { $sum: { $cond: [{ $eq: ['$status', 'refunded'] }, '$amount', 0] } },
            failedCount: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
          },
        },
      ]),
      Payment.aggregate([
        { $match: { user: userId, status: 'completed' } },
        { $group: { _id: '$method', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      Ride.countDocuments({ ...rideMatch, createdAt: { $gte: thirty } }),
    ]);

    const baseStats = rideStats[0] || {
      totalRides: 0,
      completedRides: 0,
      cancelledRides: 0,
      totalSpent: 0,
      totalDistanceKm: 0,
      avgFare: 0,
    };
    const completionRate = baseStats.totalRides
      ? Math.round((baseStats.completedRides / baseStats.totalRides) * 100)
      : 0;

    res.status(200).json({
      success: true,
      data: {
        user,
        rides,
        payments,
        wallet,
        stats: {
          ...baseStats,
          avgFare: baseStats.avgFare || 0,
          completionRate,
          last30dRides: last30,
          ridesByStatus,
          ridesByMonth,
          payments: paymentStats[0] || { totalPaid: 0, totalRefunded: 0, failedCount: 0 },
          paymentsByMethod,
        },
      },
    });
  } catch (error) {
    console.error('[admin/users/:id] error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch user' });
  }
});

/**
 * PUT /api/v1/admin/users/:id
 * Update user details
 */
router.put('/users/:id', requirePermission(PERMISSIONS.MANAGE_USERS), auditLog({ action: 'user.update', resourceType: 'User' }), async (req: Request, res: Response) => {
  try {
    const allowedFields = ['firstName', 'lastName', 'email', 'phone', 'isActive', 'isVerified', 'role'];
    const updates: Record<string, any> = {};
    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });

    const user = await User.findByIdAndUpdate(req.params.id, updates, { new: true });
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }
    res.status(200).json({ success: true, data: { user } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Update failed' });
  }
});

/**
 * PUT /api/v1/admin/users/:id/status
 * Toggle user active status
 */
router.put('/users/:id/status', requirePermission(PERMISSIONS.MANAGE_USERS), auditLog({ action: 'user.update_status', resourceType: 'User' }), async (req: Request, res: Response) => {
  try {
    const { isActive } = req.body;
    const user = await User.findByIdAndUpdate(req.params.id, { isActive }, { new: true });
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    // Notify user
    emitToUser(user._id.toString(), 'account:status', {
      isActive,
      message: isActive ? 'Your account has been activated.' : 'Your account has been suspended.',
    });

    res.status(200).json({ success: true, data: { user } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Status update failed' });
  }
});

/**
 * DELETE /api/v1/admin/users/:id
 * Soft delete user (deactivate)
 */
router.delete('/users/:id', requirePermission(PERMISSIONS.MANAGE_USERS), auditLog({ action: 'user.delete', resourceType: 'User' }), async (req: Request, res: Response) => {
  try {
    const user = await User.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }
    res.status(200).json({ success: true, message: 'User deactivated' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Delete failed' });
  }
});

// ════════════════════════════════════════════════════════════════════
// DRIVER MANAGEMENT & VERIFICATION
// ════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/admin/drivers
 * List all drivers with filters
 */
router.get('/drivers', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const { isVerified, isOnline, isOnePass, search, minRating } = req.query;

    const filter: Record<string, any> = { role: 'driver' };
    // isVerified=true now means "admin-approved" in the admin UI's vocabulary.
    // Translate it to registrationStep === 'approved' (the source of truth).
    if (isVerified !== undefined) {
      filter['driverProfile.registrationStep'] =
        isVerified === 'true' ? 'approved' : { $ne: 'approved' };
    }
    if (isOnline !== undefined) filter['driverProfile.isOnline'] = isOnline === 'true';
    if (isOnePass !== undefined) filter['driverProfile.isOnePass'] = isOnePass === 'true';
    if (minRating) filter['driverProfile.rating'] = { $gte: parseFloat(minRating as string) };
    if (search) {
      filter.$or = [
        { firstName: { $regex: search, $options: 'i' } },
        { lastName: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
        { 'driverProfile.plateNumber': { $regex: search, $options: 'i' } },
      ];
    }

    const [drivers, total] = await Promise.all([
      User.find(filter)
        .select('firstName lastName email phone avatar isVerified isActive driverProfile createdAt')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      User.countDocuments(filter),
    ]);

    // Project isVerified to mean "admin-approved" for the admin UI's
    // benefit (the field is overloaded — internally it tracks phone OTP
    // verification, but the admin panel cares about approval status).
    const projected = drivers.map((d) => {
      const obj: any = (d as any).toObject ? (d as any).toObject() : d;
      obj.isVerified = obj.driverProfile?.registrationStep === 'approved';
      return obj;
    });

    res.status(200).json({
      success: true,
      data: {
        drivers: projected,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch drivers' });
  }
});

/**
 * GET /api/v1/admin/drivers/applications
 * List pending driver applications
 */
router.get('/drivers/applications', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const status = req.query.status as string;

    const filter: Record<string, any> = { role: 'driver' };
    if (status === 'pending') {
      filter['driverProfile.registrationStep'] = { $ne: 'approved' };
    } else if (status === 'verified') {
      filter['driverProfile.registrationStep'] = 'approved';
    }

    const drivers = await User.find(filter)
      .select('firstName lastName email phone driverProfile isVerified isActive createdAt')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    const total = await User.countDocuments(filter);

    const projected = drivers.map((d) => {
      const obj: any = (d as any).toObject ? (d as any).toObject() : d;
      obj.isVerified = obj.driverProfile?.registrationStep === 'approved';
      return obj;
    });

    res.status(200).json({
      success: true,
      data: {
        drivers: projected,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch applications' });
  }
});

/**
 * GET /api/v1/admin/drivers/online
 * Get all online drivers with current locations
 */
router.get('/drivers/online', async (_req: Request, res: Response) => {
  try {
    const drivers = await User.find({
      role: 'driver',
      'driverProfile.isOnline': true,
    }).select('firstName lastName phone avatar driverProfile.currentLocation driverProfile.rating driverProfile.vehicleMake driverProfile.vehicleModel driverProfile.plateNumber');

    res.status(200).json({ success: true, data: { drivers, count: drivers.length } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch online drivers' });
  }
});

/**
 * GET /api/v1/admin/drivers/low-rated
 * Get drivers with low ratings for review
 */
router.get('/drivers/low-rated', async (req: Request, res: Response) => {
  try {
    const threshold = parseFloat(req.query.threshold as string) || 4.0;
    const minTrips = parseInt(req.query.minTrips as string) || 10;

    const drivers = await User.find({
      role: 'driver',
      'driverProfile.rating': { $lt: threshold, $gt: 0 },
      'driverProfile.totalTrips': { $gte: minTrips },
    })
      .select('firstName lastName phone driverProfile.rating driverProfile.totalTrips isActive')
      .sort({ 'driverProfile.rating': 1 });

    res.status(200).json({ success: true, data: { drivers, threshold, count: drivers.length } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch low-rated drivers' });
  }
});

/**
 * GET /api/v1/admin/drivers/:id
 * Get full driver profile with statistics
 */
router.get('/drivers/:id', async (req: Request, res: Response) => {
  try {
    const driver = await User.findOne({ _id: req.params.id, role: 'driver' });
    if (!driver) {
      res.status(404).json({ success: false, message: 'Driver not found' });
      return;
    }

    const [rides, earnings, recentRatings] = await Promise.all([
      Ride.find({ driver: driver._id })
        .populate('customer', 'firstName lastName')
        .sort({ createdAt: -1 })
        .limit(20),
      Payment.aggregate([
        { $match: { user: driver._id, type: 'ride_payment', status: 'completed' } },
        {
          $group: {
            _id: null,
            total: { $sum: '$amount' },
            thisWeek: {
              $sum: {
                $cond: [
                  { $gte: ['$createdAt', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)] },
                  '$amount',
                  0,
                ],
              },
            },
            thisMonth: {
              $sum: {
                $cond: [
                  { $gte: ['$createdAt', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)] },
                  '$amount',
                  0,
                ],
              },
            },
          },
        },
      ]),
      Ride.find({ driver: driver._id, 'rating.customerToDriver': { $exists: true } })
        .select('rating createdAt')
        .sort({ createdAt: -1 })
        .limit(10),
    ]);

    res.status(200).json({
      success: true,
      data: {
        driver: (() => {
          // Mirror the list endpoint: derive `isVerified` from the
          // application registration step so the admin UI sees the same
          // approval status on the detail view as on the list view.
          const obj: any = driver.toObject();
          obj.isVerified = obj.driverProfile?.registrationStep === 'approved';
          return obj;
        })(),
        rides,
        earnings: earnings[0] || { total: 0, thisWeek: 0, thisMonth: 0 },
        recentRatings,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch driver' });
  }
});

/**
 * GET /api/v1/admin/drivers/:id/documents
 * Get driver documents for verification
 */
router.get('/drivers/:id/documents', async (req: Request, res: Response) => {
  try {
    const driver = await User.findById(req.params.id).select('firstName lastName driverProfile');
    if (!driver || driver.role !== 'driver') {
      res.status(404).json({ success: false, message: 'Driver not found' });
      return;
    }

    res.status(200).json({
      success: true,
      data: {
        driver: {
          id: driver._id,
          name: `${driver.firstName} ${driver.lastName}`,
        },
        documents: driver.driverProfile?.documents || [],
        vehicle: {
          make: driver.driverProfile?.vehicleMake,
          model: driver.driverProfile?.vehicleModel,
          year: driver.driverProfile?.vehicleYear,
          color: driver.driverProfile?.vehicleColor,
          plate: driver.driverProfile?.plateNumber,
        },
        licence: driver.driverProfile?.licenceNumber,
        insurance: driver.driverProfile?.insuranceNumber,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch documents' });
  }
});

/**
 * PUT /api/v1/admin/drivers/:id/verify-document
 * Verify or reject a specific document
 */
router.put('/drivers/:id/verify-document', requirePermission(PERMISSIONS.APPROVE_DRIVERS), auditLog({ action: 'driver.verify_document', resourceType: 'User' }), async (req: Request, res: Response) => {
  try {
    const { documentType, status, reason } = req.body;

    const driver = await User.findById(req.params.id);
    if (!driver || !driver.driverProfile?.documents) {
      res.status(404).json({ success: false, message: 'Driver not found' });
      return;
    }

    const docIndex = driver.driverProfile.documents.findIndex((d: any) => d.type === documentType);
    if (docIndex === -1) {
      res.status(404).json({ success: false, message: 'Document not found' });
      return;
    }

    driver.driverProfile.documents[docIndex].status = status;
    await driver.save();

    // Notify driver
    emitToUser(driver._id.toString(), 'document:status', {
      documentType,
      status,
      reason,
      message: status === 'verified' ? `Your ${documentType} has been verified.` : `Your ${documentType} was rejected: ${reason}`,
    });

    res.status(200).json({ success: true, message: `Document ${status}` });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Verification failed' });
  }
});

/**
 * PUT /api/v1/admin/drivers/:id/approve
 * Approve driver application
 */
router.put('/drivers/:id/approve', requirePermission(PERMISSIONS.APPROVE_DRIVERS), auditLog({ action: 'driver.approve', resourceType: 'User' }), async (req: Request, res: Response) => {
  try {
    const driver = await User.findByIdAndUpdate(
      req.params.id,
      { isVerified: true, isActive: true },
      { new: true }
    );

    if (!driver) {
      res.status(404).json({ success: false, message: 'Driver not found' });
      return;
    }

    emitToUser(driver._id.toString(), 'application:approved', {
      message: 'Congratulations! Your driver application has been approved. You can now go online and accept rides.',
    });

    res.status(200).json({ success: true, data: { driver }, message: 'Driver approved' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Approval failed' });
  }
});

/**
 * PUT /api/v1/admin/drivers/:id/reject
 * Reject driver application
 */
router.put('/drivers/:id/reject', requirePermission(PERMISSIONS.APPROVE_DRIVERS), auditLog({ action: 'driver.reject', resourceType: 'User' }), async (req: Request, res: Response) => {
  try {
    const { reason } = req.body;

    const driver = await User.findByIdAndUpdate(
      req.params.id,
      { isVerified: false, isActive: false },
      { new: true }
    );

    if (!driver) {
      res.status(404).json({ success: false, message: 'Driver not found' });
      return;
    }

    emitToUser(driver._id.toString(), 'application:rejected', {
      reason,
      message: `Your driver application was not approved. Reason: ${reason}`,
    });

    res.status(200).json({ success: true, message: 'Application rejected' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Rejection failed' });
  }
});

/**
 * PUT /api/v1/admin/drivers/:id/force-offline
 * Force a driver offline (for violations/emergencies)
 */
router.put('/drivers/:id/force-offline', requirePermission(PERMISSIONS.FORCE_OFFLINE), auditLog({ action: 'driver.force_offline', resourceType: 'User' }), async (req: Request, res: Response) => {
  try {
    const { reason } = req.body;

    const driver = await User.findByIdAndUpdate(
      req.params.id,
      { 'driverProfile.isOnline': false },
      { new: true }
    );

    if (!driver) {
      res.status(404).json({ success: false, message: 'Driver not found' });
      return;
    }

    emitToUser(req.params.id, 'driver:force-offline', {
      reason,
      message: `You have been taken offline by admin. Reason: ${reason}`,
    });

    res.status(200).json({ success: true, message: 'Driver forced offline' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Operation failed' });
  }
});

/**
 * PUT /api/v1/admin/drivers/:id/update-vehicle
 * Update driver vehicle information
 */
router.put('/drivers/:id/update-vehicle', requirePermission(PERMISSIONS.MANAGE_DRIVERS), auditLog({ action: 'driver.update_vehicle', resourceType: 'User' }), async (req: Request, res: Response) => {
  try {
    const { vehicleMake, vehicleModel, vehicleYear, vehicleColor, plateNumber } = req.body;

    const updates: Record<string, any> = {};
    if (vehicleMake) updates['driverProfile.vehicleMake'] = vehicleMake;
    if (vehicleModel) updates['driverProfile.vehicleModel'] = vehicleModel;
    if (vehicleYear) updates['driverProfile.vehicleYear'] = vehicleYear;
    if (vehicleColor) updates['driverProfile.vehicleColor'] = vehicleColor;
    if (plateNumber) updates['driverProfile.plateNumber'] = plateNumber;

    const driver = await User.findByIdAndUpdate(req.params.id, updates, { new: true });

    res.status(200).json({ success: true, data: { driver } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Update failed' });
  }
});

// ════════════════════════════════════════════════════════════════════
// ONEPASS SUBSCRIPTION MANAGEMENT
// ════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/admin/onepass/subscribers
 * List all OnePass subscribers
 */
router.get('/onepass/subscribers', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const status = req.query.status as string;

    const filter: Record<string, any> = { role: 'driver', 'driverProfile.isOnePass': true };
    if (status === 'expired') {
      filter['driverProfile.onePassExpiry'] = { $lt: new Date() };
    } else if (status === 'active') {
      filter['driverProfile.onePassExpiry'] = { $gte: new Date() };
    }

    const [subscribers, total] = await Promise.all([
      User.find(filter)
        .select('firstName lastName phone email driverProfile.onePassExpiry driverProfile.totalEarnings driverProfile.totalTrips')
        .sort({ 'driverProfile.onePassExpiry': -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      User.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: { subscribers, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch subscribers' });
  }
});

/**
 * GET /api/v1/admin/onepass/stats
 * OnePass subscription statistics
 */
router.get('/onepass/stats', async (_req: Request, res: Response) => {
  try {
    const [total, active, expired, revenue] = await Promise.all([
      User.countDocuments({ role: 'driver', 'driverProfile.isOnePass': true }),
      User.countDocuments({ role: 'driver', 'driverProfile.isOnePass': true, 'driverProfile.onePassExpiry': { $gte: new Date() } }),
      User.countDocuments({ role: 'driver', 'driverProfile.isOnePass': true, 'driverProfile.onePassExpiry': { $lt: new Date() } }),
      Payment.aggregate([
        { $match: { type: 'subscription', status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
    ]);

    res.status(200).json({
      success: true,
      data: {
        total,
        active,
        expired,
        revenue: revenue[0]?.total || 0,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

/**
 * PUT /api/v1/admin/onepass/:driverId/extend
 * Extend OnePass subscription
 */
router.put('/onepass/:driverId/extend', requirePermission(PERMISSIONS.MANAGE_ONEPASS), auditLog({ action: 'onepass.extend', resourceType: 'User', resourceId: (req) => req.params.driverId }), async (req: Request, res: Response) => {
  try {
    const { days } = req.body;

    if (!days || days <= 0) {
      res.status(400).json({ success: false, message: 'Valid number of days required' });
      return;
    }

    const driver = await User.findById(req.params.driverId);
    if (!driver) {
      res.status(404).json({ success: false, message: 'Driver not found' });
      return;
    }

    const currentExpiry = driver.driverProfile?.onePassExpiry || new Date();
    const baseDate = currentExpiry > new Date() ? currentExpiry : new Date();
    const newExpiry = new Date(baseDate.getTime() + days * 24 * 60 * 60 * 1000);

    await User.findByIdAndUpdate(req.params.driverId, {
      'driverProfile.isOnePass': true,
      'driverProfile.onePassExpiry': newExpiry,
    });

    emitToUser(req.params.driverId, 'onepass:extended', {
      newExpiry,
      message: `Your OnePass subscription has been extended by ${days} days.`,
    });

    res.status(200).json({ success: true, data: { newExpiry, daysAdded: days } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Extension failed' });
  }
});

/**
 * PUT /api/v1/admin/onepass/:driverId/cancel
 * Cancel OnePass subscription
 */
router.put('/onepass/:driverId/cancel', requirePermission(PERMISSIONS.MANAGE_ONEPASS), auditLog({ action: 'onepass.cancel', resourceType: 'User', resourceId: (req) => req.params.driverId }), async (req: Request, res: Response) => {
  try {
    const { reason } = req.body;

    await User.findByIdAndUpdate(req.params.driverId, {
      'driverProfile.isOnePass': false,
      'driverProfile.onePassExpiry': null,
    });

    emitToUser(req.params.driverId, 'onepass:cancelled', {
      reason,
      message: `Your OnePass subscription has been cancelled. ${reason || ''}`,
    });

    res.status(200).json({ success: true, message: 'Subscription cancelled' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Cancellation failed' });
  }
});

/**
 * POST /api/v1/admin/onepass/:driverId/grant
 * Grant free OnePass subscription
 */
router.post('/onepass/:driverId/grant', requirePermission(PERMISSIONS.MANAGE_ONEPASS), auditLog({ action: 'onepass.grant', resourceType: 'User', resourceId: (req) => req.params.driverId }), async (req: Request, res: Response) => {
  try {
    const { days, reason } = req.body;

    const newExpiry = new Date(Date.now() + (days || 30) * 24 * 60 * 60 * 1000);

    await User.findByIdAndUpdate(req.params.driverId, {
      'driverProfile.isOnePass': true,
      'driverProfile.onePassExpiry': newExpiry,
    });

    emitToUser(req.params.driverId, 'onepass:granted', {
      expiry: newExpiry,
      message: `You've been granted a free OnePass subscription! ${reason || ''}`,
    });

    res.status(200).json({ success: true, data: { expiry: newExpiry } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Grant failed' });
  }
});

// ════════════════════════════════════════════════════════════════════
// RIDE MANAGEMENT
// ════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/admin/rides
 * List rides with advanced filters
 */
router.get('/rides', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const { status, rideType, startDate, endDate, customerId, driverId, paymentMethod, minFare, maxFare } = req.query;

    const filter: Record<string, any> = {};
    if (status) filter.status = status;
    if (rideType) filter.rideType = rideType;
    if (customerId) filter.customer = customerId;
    if (driverId) filter.driver = driverId;
    if (paymentMethod) filter.paymentMethod = paymentMethod;
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate as string);
      if (endDate) filter.createdAt.$lte = new Date(endDate as string);
    }
    if (minFare || maxFare) {
      filter.estimatedFare = {};
      if (minFare) filter.estimatedFare.$gte = parseFloat(minFare as string);
      if (maxFare) filter.estimatedFare.$lte = parseFloat(maxFare as string);
    }

    const [rides, total] = await Promise.all([
      Ride.find(filter)
        .populate('customer', 'firstName lastName phone')
        .populate('driver', 'firstName lastName phone')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Ride.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: { rides, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch rides' });
  }
});

/**
 * GET /api/v1/admin/rides/live
 * Get all active rides for live monitoring
 */
router.get('/rides/live', async (_req: Request, res: Response) => {
  try {
    const activeRides = await Ride.find({
      status: { $in: ['searching', 'driver_assigned', 'driver_arriving', 'driver_arrived', 'in_progress'] },
    })
      .populate('customer', 'firstName lastName phone avatar')
      .populate('driver', 'firstName lastName phone avatar driverProfile.currentLocation driverProfile.vehicleMake driverProfile.vehicleModel driverProfile.plateNumber')
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      data: {
        rides: activeRides,
        count: activeRides.length,
        searching: activeRides.filter(r => r.status === 'searching').length,
        inProgress: activeRides.filter(r => r.status === 'in_progress').length,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch live rides' });
  }
});

/**
 * GET /api/v1/admin/rides/scheduled
 * Get scheduled rides
 */
router.get('/rides/scheduled', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;

    const rides = await Ride.find({
      isScheduled: true,
      scheduledAt: { $gte: new Date() },
      status: { $nin: ['completed', 'cancelled'] },
    })
      .populate('customer', 'firstName lastName phone')
      .populate('driver', 'firstName lastName phone')
      .sort({ scheduledAt: 1 })
      .skip((page - 1) * limit)
      .limit(limit);

    const total = await Ride.countDocuments({
      isScheduled: true,
      scheduledAt: { $gte: new Date() },
      status: { $nin: ['completed', 'cancelled'] },
    });

    res.status(200).json({
      success: true,
      data: { rides, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch scheduled rides' });
  }
});

/**
 * GET /api/v1/admin/rides/disputed
 * Get rides with issues (low ratings, disputes)
 */
router.get('/rides/disputed', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;

    const filter = {
      $or: [
        { 'rating.customerToDriver': { $lte: 2 } },
        { 'rating.driverToCustomer': { $lte: 2 } },
        { status: 'cancelled', 'cancellation.fee': { $gt: 0 } },
      ],
    };

    const [rides, total] = await Promise.all([
      Ride.find(filter)
        .populate('customer', 'firstName lastName phone')
        .populate('driver', 'firstName lastName phone')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Ride.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: { rides, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch disputed rides' });
  }
});

/**
 * GET /api/v1/admin/rides/:id
 * Get full ride details with chat and payment
 */
router.get('/rides/:id', async (req: Request, res: Response) => {
  try {
    const ride = await Ride.findById(req.params.id)
      .populate('customer', 'firstName lastName phone email avatar savedAddresses')
      .populate('driver', 'firstName lastName phone email avatar driverProfile');

    if (!ride) {
      res.status(404).json({ success: false, message: 'Ride not found' });
      return;
    }

    const [chat, payment] = await Promise.all([
      Chat.findOne({ ride: ride._id }),
      Payment.findOne({ ride: ride._id }),
    ]);

    res.status(200).json({ success: true, data: { ride, chat, payment } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch ride' });
  }
});

/**
 * PUT /api/v1/admin/rides/:id/cancel
 * Admin cancel a ride with optional refund
 */
router.put('/rides/:id/cancel', requirePermission(PERMISSIONS.MANAGE_RIDES), auditLog({ action: 'ride.cancel', resourceType: 'Ride' }), async (req: Request, res: Response) => {
  try {
    const { reason, refund, refundAmount } = req.body;

    const ride = await Ride.findById(req.params.id);
    if (!ride) {
      res.status(404).json({ success: false, message: 'Ride not found' });
      return;
    }

    if (['completed', 'cancelled'].includes(ride.status)) {
      res.status(400).json({ success: false, message: 'Ride cannot be cancelled' });
      return;
    }

    ride.status = 'cancelled';
    ride.cancellation = {
      cancelledBy: 'system',
      reason: reason || 'Cancelled by admin',
      fee: 0,
      cancelledAt: new Date(),
    };
    await ride.save();

    // Notify both parties
    emitToUser(ride.customer.toString(), 'ride:cancelled', {
      rideId: ride._id,
      reason,
      message: `Your ride has been cancelled. ${reason || ''}`,
    });

    if (ride.driver) {
      emitToUser(ride.driver.toString(), 'ride:cancelled', {
        rideId: ride._id,
        reason,
        message: `Ride cancelled by admin. ${reason || ''}`,
      });
    }

    // Process refund if requested
    if (refund && ride.paymentStatus === 'completed') {
      const amount = refundAmount || ride.actualFare || ride.estimatedFare;

      await Payment.create({
        user: ride.customer,
        ride: ride._id,
        type: 'refund',
        amount,
        method: ride.paymentMethod,
        status: 'completed',
        description: `Ride cancelled - admin refund. ${reason || ''}`,
      });

      // Credit to wallet if not cash
      if (ride.paymentMethod !== 'cash') {
        await Wallet.findOneAndUpdate(
          { user: ride.customer },
          { $inc: { balance: amount } }
        );
      }
    }

    res.status(200).json({ success: true, data: { ride }, message: 'Ride cancelled' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Cancellation failed' });
  }
});

/**
 * PUT /api/v1/admin/rides/:id/reassign
 * Reassign ride to a different driver
 */
router.put('/rides/:id/reassign', requirePermission(PERMISSIONS.MANAGE_RIDES), auditLog({ action: 'ride.reassign', resourceType: 'Ride' }), async (req: Request, res: Response) => {
  try {
    const { driverId, reason } = req.body;

    const [ride, newDriver] = await Promise.all([
      Ride.findById(req.params.id),
      User.findOne({ _id: driverId, role: 'driver', isVerified: true, isActive: true }),
    ]);

    if (!ride) {
      res.status(404).json({ success: false, message: 'Ride not found' });
      return;
    }

    if (!newDriver) {
      res.status(404).json({ success: false, message: 'Valid driver not found' });
      return;
    }

    if (['completed', 'cancelled'].includes(ride.status)) {
      res.status(400).json({ success: false, message: 'Cannot reassign completed/cancelled ride' });
      return;
    }

    const oldDriverId = ride.driver;

    // Notify old driver
    if (oldDriverId) {
      emitToUser(oldDriverId.toString(), 'ride:reassigned', {
        rideId: ride._id,
        reason,
        message: `Ride has been reassigned. ${reason || ''}`,
      });
    }

    ride.driver = newDriver._id;
    ride.status = 'driver_assigned';
    await ride.save();

    // Notify new driver
    emitToUser(driverId, 'ride:assigned', {
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
        name: `${newDriver.firstName} ${newDriver.lastName}`,
        phone: newDriver.phone,
        vehicle: newDriver.driverProfile,
      },
      message: 'Your driver has been changed.',
    });

    res.status(200).json({ success: true, data: { ride }, message: 'Ride reassigned' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Reassignment failed' });
  }
});

/**
 * PUT /api/v1/admin/rides/:id/adjust-fare
 * Adjust ride fare
 */
router.put('/rides/:id/adjust-fare', requirePermission(PERMISSIONS.ADJUST_FARE), auditLog({ action: 'ride.adjust_fare', resourceType: 'Ride' }), async (req: Request, res: Response) => {
  try {
    const { newFare, reason } = req.body;

    const ride = await Ride.findById(req.params.id);
    if (!ride) {
      res.status(404).json({ success: false, message: 'Ride not found' });
      return;
    }

    const oldFare = ride.actualFare || ride.estimatedFare;
    ride.actualFare = newFare;
    await ride.save();

    // Notify customer
    emitToUser(ride.customer.toString(), 'ride:fare-adjusted', {
      rideId: ride._id,
      oldFare,
      newFare,
      reason,
      message: `Your ride fare has been adjusted from ₹${oldFare.toFixed(2)} to ₹${newFare.toFixed(2)}. ${reason || ''}`,
    });

    res.status(200).json({ success: true, data: { ride, oldFare, newFare } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Fare adjustment failed' });
  }
});

// ════════════════════════════════════════════════════════════════════
// PROMO CODE MANAGEMENT
// ════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/admin/promos
 * List all promo codes
 */
router.get('/promos', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const { isActive, search } = req.query;

    const filter: Record<string, any> = {};
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    if (search) filter.code = { $regex: search, $options: 'i' };

    const [promos, total] = await Promise.all([
      PromoCode.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      PromoCode.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: { promos, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch promos' });
  }
});

/**
 * GET /api/v1/admin/promos/stats
 * Promo code usage statistics
 */
router.get('/promos/stats', async (_req: Request, res: Response) => {
  try {
    const [totalPromos, activePromos, totalUsage, totalDiscount] = await Promise.all([
      PromoCode.countDocuments(),
      PromoCode.countDocuments({ isActive: true, expiresAt: { $gt: new Date() } }),
      PromoCode.aggregate([{ $group: { _id: null, total: { $sum: '$usedCount' } } }]),
      Ride.aggregate([
        { $match: { discount: { $gt: 0 } } },
        { $group: { _id: null, total: { $sum: '$discount' } } },
      ]),
    ]);

    const topPromos = await PromoCode.find()
      .sort({ usedCount: -1 })
      .limit(5)
      .select('code usedCount type value');

    res.status(200).json({
      success: true,
      data: {
        totalPromos,
        activePromos,
        totalUsage: totalUsage[0]?.total || 0,
        totalDiscountGiven: totalDiscount[0]?.total || 0,
        topPromos,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch promo stats' });
  }
});

/**
 * GET /api/v1/admin/promos/:id
 * Get single promo code details
 */
router.get('/promos/:id', async (req: Request, res: Response) => {
  try {
    const promo = await PromoCode.findById(req.params.id);
    if (!promo) {
      res.status(404).json({ success: false, message: 'Promo not found' });
      return;
    }

    // Get rides that used this promo
    const usageHistory = await Ride.find({ promoCode: promo.code })
      .populate('customer', 'firstName lastName')
      .select('customer discount createdAt')
      .sort({ createdAt: -1 })
      .limit(20);

    res.status(200).json({ success: true, data: { promo, usageHistory } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch promo' });
  }
});

/**
 * POST /api/v1/admin/promos
 * Create a new promo code
 */
router.post('/promos', requirePermission(PERMISSIONS.MANAGE_PROMOS), auditLog({ action: 'promo.create', resourceType: 'PromoCode' }), async (req: Request, res: Response) => {
  try {
    const { code, type, value, maxUses, minFare, maxDiscount, expiresAt, description } = req.body;

    if (!code || !type || !value || !expiresAt) {
      res.status(400).json({ success: false, message: 'Code, type, value, and expiresAt are required' });
      return;
    }

    const promo = await PromoCode.create({
      code: code.toUpperCase().replace(/\s/g, ''),
      type,
      value,
      maxUses: maxUses || 100,
      minFare: minFare || 0,
      maxDiscount: maxDiscount || 50,
      expiresAt: new Date(expiresAt),
      isActive: true,
    });

    res.status(201).json({ success: true, data: { promo } });
  } catch (error: any) {
    if (error.code === 11000) {
      res.status(400).json({ success: false, message: 'Promo code already exists' });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to create promo' });
  }
});

/**
 * PUT /api/v1/admin/promos/:id
 * Update promo code
 */
router.put('/promos/:id', requirePermission(PERMISSIONS.MANAGE_PROMOS), auditLog({ action: 'promo.update', resourceType: 'PromoCode' }), async (req: Request, res: Response) => {
  try {
    const updates = { ...req.body };
    if (updates.code) updates.code = updates.code.toUpperCase().replace(/\s/g, '');
    if (updates.expiresAt) updates.expiresAt = new Date(updates.expiresAt);

    const promo = await PromoCode.findByIdAndUpdate(req.params.id, updates, { new: true });
    if (!promo) {
      res.status(404).json({ success: false, message: 'Promo not found' });
      return;
    }

    res.status(200).json({ success: true, data: { promo } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Update failed' });
  }
});

/**
 * PUT /api/v1/admin/promos/:id/toggle
 * Toggle promo code active status
 */
router.put('/promos/:id/toggle', requirePermission(PERMISSIONS.MANAGE_PROMOS), auditLog({ action: 'promo.toggle', resourceType: 'PromoCode' }), async (req: Request, res: Response) => {
  try {
    const promo = await PromoCode.findById(req.params.id);
    if (!promo) {
      res.status(404).json({ success: false, message: 'Promo not found' });
      return;
    }

    promo.isActive = !promo.isActive;
    await promo.save();

    res.status(200).json({ success: true, data: { promo, isActive: promo.isActive } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Toggle failed' });
  }
});

/**
 * DELETE /api/v1/admin/promos/:id
 * Delete promo code
 */
router.delete('/promos/:id', requirePermission(PERMISSIONS.MANAGE_PROMOS), auditLog({ action: 'promo.delete', resourceType: 'PromoCode' }), async (req: Request, res: Response) => {
  try {
    const promo = await PromoCode.findByIdAndDelete(req.params.id);
    if (!promo) {
      res.status(404).json({ success: false, message: 'Promo not found' });
      return;
    }
    res.status(200).json({ success: true, message: 'Promo deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Delete failed' });
  }
});

// ════════════════════════════════════════════════════════════════════
// PAYMENT & WALLET MANAGEMENT
// ════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/admin/payments
 * List all payments
 */
router.get('/payments', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const { type, status, method, userId, startDate, endDate } = req.query;

    const filter: Record<string, any> = {};
    if (type) filter.type = type;
    if (status) filter.status = status;
    if (method) filter.method = method;
    if (userId) filter.user = userId;
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate as string);
      if (endDate) filter.createdAt.$lte = new Date(endDate as string);
    }

    const [payments, total] = await Promise.all([
      Payment.find(filter)
        .populate('user', 'firstName lastName phone role')
        .populate('ride', 'pickup.address dropoff.address actualFare')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Payment.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: { payments, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch payments' });
  }
});

/**
 * GET /api/v1/admin/payments/stats
 * Payment statistics
 */
router.get('/payments/stats', async (req: Request, res: Response) => {
  try {
    const { startDate, endDate } = req.query;
    const start = startDate ? new Date(startDate as string) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate as string) : new Date();

    const [byType, byMethod, byStatus] = await Promise.all([
      Payment.aggregate([
        { $match: { createdAt: { $gte: start, $lte: end } } },
        { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      Payment.aggregate([
        { $match: { createdAt: { $gte: start, $lte: end }, status: 'completed' } },
        { $group: { _id: '$method', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      Payment.aggregate([
        { $match: { createdAt: { $gte: start, $lte: end } } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
    ]);

    res.status(200).json({
      success: true,
      data: { byType, byMethod, byStatus, dateRange: { start, end } },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch payment stats' });
  }
});

/**
 * POST /api/v1/admin/payments/refund
 * Issue a refund
 */
router.post('/payments/refund', requirePermission(PERMISSIONS.REFUND_PAYMENTS), auditLog({ action: 'payment.refund', resourceType: 'Payment', resourceId: (req) => req.body?.paymentId }), async (req: Request, res: Response) => {
  try {
    const { paymentId, amount, reason } = req.body;

    const originalPayment = await Payment.findById(paymentId);
    if (!originalPayment) {
      res.status(404).json({ success: false, message: 'Payment not found' });
      return;
    }

    if (originalPayment.status !== 'completed') {
      res.status(400).json({ success: false, message: 'Can only refund completed payments' });
      return;
    }

    const refundAmount = amount || originalPayment.amount;

    if (refundAmount > originalPayment.amount) {
      res.status(400).json({ success: false, message: 'Refund amount cannot exceed original payment' });
      return;
    }

    // Create refund record
    const refund = await Payment.create({
      user: originalPayment.user,
      ride: originalPayment.ride,
      type: 'refund',
      amount: refundAmount,
      method: originalPayment.method,
      status: 'completed',
      description: reason || 'Admin refund',
    });

    // Update original payment status
    await Payment.findByIdAndUpdate(paymentId, { status: 'refunded' });

    // Add to wallet if not cash
    if (originalPayment.method !== 'cash') {
      await Wallet.findOneAndUpdate(
        { user: originalPayment.user },
        { $inc: { balance: refundAmount } },
        { upsert: true }
      );
    }

    // Notify user
    emitToUser(originalPayment.user.toString(), 'payment:refund', {
      amount: refundAmount,
      reason,
      message: `You've received a refund of ₹${refundAmount.toFixed(2)}. ${reason || ''}`,
    });

    res.status(201).json({ success: true, data: { refund } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Refund failed' });
  }
});

/**
 * GET /api/v1/admin/wallets
 * List all wallets
 */
router.get('/wallets', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const { minBalance, maxBalance, role } = req.query;

    let filter: Record<string, any> = {};

    // Build pipeline for joins
    const pipeline: any[] = [
      {
        $lookup: {
          from: 'users',
          localField: 'user',
          foreignField: '_id',
          as: 'userInfo',
        },
      },
      { $unwind: '$userInfo' },
    ];

    if (role) {
      pipeline.push({ $match: { 'userInfo.role': role } });
    }

    if (minBalance) {
      pipeline.push({ $match: { balance: { $gte: parseFloat(minBalance as string) } } });
    }

    if (maxBalance) {
      pipeline.push({ $match: { balance: { $lte: parseFloat(maxBalance as string) } } });
    }

    pipeline.push({ $sort: { balance: -1 } });
    pipeline.push({ $skip: (page - 1) * limit });
    pipeline.push({ $limit: limit });
    pipeline.push({
      $project: {
        balance: 1,
        currency: 1,
        user: {
          _id: '$userInfo._id',
          firstName: '$userInfo.firstName',
          lastName: '$userInfo.lastName',
          phone: '$userInfo.phone',
          role: '$userInfo.role',
        },
      },
    });

    const wallets = await Wallet.aggregate(pipeline);
    const total = await Wallet.countDocuments();

    res.status(200).json({
      success: true,
      data: { wallets, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch wallets' });
  }
});

/**
 * GET /api/v1/admin/wallets/:userId
 * Get user wallet with transaction history
 */
router.get('/wallets/:userId', async (req: Request, res: Response) => {
  try {
    const [wallet, transactions, user] = await Promise.all([
      Wallet.findOne({ user: req.params.userId }),
      Payment.find({
        user: req.params.userId,
        $or: [{ type: 'wallet_topup' }, { method: 'wallet' }],
      })
        .sort({ createdAt: -1 })
        .limit(50),
      User.findById(req.params.userId).select('firstName lastName phone role'),
    ]);

    if (!wallet) {
      res.status(404).json({ success: false, message: 'Wallet not found' });
      return;
    }

    res.status(200).json({
      success: true,
      data: { wallet, transactions, user },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch wallet' });
  }
});

/**
 * PUT /api/v1/admin/wallets/:userId/adjust
 * Adjust wallet balance (credit/debit)
 */
router.put('/wallets/:userId/adjust', requirePermission(PERMISSIONS.ADJUST_WALLET), auditLog({ action: 'wallet.adjust', resourceType: 'Wallet', resourceId: (req) => req.params.userId }), async (req: Request, res: Response) => {
  try {
    const { amount, type, reason } = req.body; // type: 'credit' | 'debit'

    if (!amount || amount <= 0) {
      res.status(400).json({ success: false, message: 'Valid amount required' });
      return;
    }

    if (!['credit', 'debit'].includes(type)) {
      res.status(400).json({ success: false, message: 'Type must be credit or debit' });
      return;
    }

    let wallet = await Wallet.findOne({ user: req.params.userId });
    if (!wallet) {
      wallet = await Wallet.create({ user: req.params.userId, balance: 0, currency: 'INR' });
    }

    const adjustment = type === 'debit' ? -Math.abs(amount) : Math.abs(amount);
    const newBalance = Math.max(0, wallet.balance + adjustment);
    wallet.balance = newBalance;
    await wallet.save();

    // Log the adjustment as a payment record
    await Payment.create({
      user: req.params.userId,
      type: type === 'debit' ? 'cancellation_fee' : 'wallet_topup',
      amount: Math.abs(amount),
      method: 'wallet',
      status: 'completed',
      description: `Admin ${type}: ${reason || 'Balance adjustment'}`,
    });

    // Notify user
    emitToUser(req.params.userId, 'wallet:adjusted', {
      type,
      amount: Math.abs(amount),
      newBalance,
      reason,
      message: type === 'credit'
        ? `₹${amount.toFixed(2)} has been added to your wallet. ${reason || ''}`
        : `₹${amount.toFixed(2)} has been deducted from your wallet. ${reason || ''}`,
    });

    res.status(200).json({ success: true, data: { wallet, adjustment: { type, amount, reason } } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Adjustment failed' });
  }
});

// ════════════════════════════════════════════════════════════════════
// CHAT / SUPPORT
// ════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/admin/chats
 * List all ride chats
 */
router.get('/chats', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;

    const [chats, total] = await Promise.all([
      Chat.find()
        .populate('ride', 'status pickup.address dropoff.address')
        .populate('participants', 'firstName lastName role')
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Chat.countDocuments(),
    ]);

    res.status(200).json({
      success: true,
      data: { chats, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch chats' });
  }
});

/**
 * GET /api/v1/admin/chats/:rideId
 * Get chat for a specific ride
 */
router.get('/chats/:rideId', async (req: Request, res: Response) => {
  try {
    const chat = await Chat.findOne({ ride: req.params.rideId })
      .populate('ride')
      .populate('participants', 'firstName lastName phone role avatar');

    if (!chat) {
      res.status(404).json({ success: false, message: 'Chat not found' });
      return;
    }

    res.status(200).json({ success: true, data: { chat } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch chat' });
  }
});

// ════════════════════════════════════════════════════════════════════
// SETTINGS & CONFIGURATION
// ════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/admin/settings/fares
 * Get current fare settings
 */
router.get('/settings/fares', async (_req: Request, res: Response) => {
  try {
    res.status(200).json({
      success: true,
      data: {
        baseFares: config.ride?.baseFares || {
          economy: { base: 3.0, perKm: 1.2, perMin: 0.15 },
          comfort: { base: 4.5, perKm: 1.6, perMin: 0.20 },
          premium: { base: 7.0, perKm: 2.2, perMin: 0.30 },
          xl: { base: 5.5, perKm: 1.8, perMin: 0.22 },
          electric: { base: 3.5, perKm: 1.4, perMin: 0.18 },
        },
        commission: config.ride?.commissionRate || 0.20,
        cancellationFee: config.ride?.cancellationFee || 5.0,
        minFare: config.ride?.minFare || 5.0,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch fare settings' });
  }
});

/**
 * GET /api/v1/admin/settings/general
 * Get general app settings
 */
router.get('/settings/general', async (_req: Request, res: Response) => {
  try {
    res.status(200).json({
      success: true,
      data: {
        appName: 'UKCAAR',
        currency: 'INR',
        currencySymbol: '₹',
        supportEmail: 'support@ukcaar.com',
        supportPhone: '+44 800 123 4567',
        maxSearchRadius: 10, // km
        rideTypes: ['economy', 'comfort', 'premium', 'xl', 'electric'],
        paymentMethods: ['card', 'cash', 'wallet'],
        onePassPrice: 99.99,
        onePassDuration: 30, // days
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch settings' });
  }
});

// ════════════════════════════════════════════════════════════════════
// NOTIFICATIONS / BROADCAST
// ════════════════════════════════════════════════════════════════════

/**
 * POST /api/v1/admin/broadcast
 * Send broadcast notification to users
 */
router.post('/broadcast', requirePermission(PERMISSIONS.SEND_NOTIFICATIONS), auditLog({ action: 'notification.broadcast', resourceType: 'Notification' }), async (req: Request, res: Response) => {
  try {
    const { title, message, targetRole, targetUserIds } = req.body;

    if (!title || !message) {
      res.status(400).json({ success: false, message: 'Title and message are required' });
      return;
    }

    const filter: Record<string, any> = { isActive: true };
    if (targetRole) filter.role = targetRole;
    if (targetUserIds?.length) filter._id = { $in: targetUserIds };

    const users = await User.find(filter).select('_id fcmTokens');
    if (users.length === 0) {
      res.status(200).json({
        success: true,
        message: 'No matching users found',
        data: { sentCount: 0, pushCount: 0 },
      });
      return;
    }

    // 1) Persist an in-app notification record per user (so the bell icon / feed shows it).
    const notificationDocs = users.map((u) => ({
      user: u._id,
      title,
      body: message,
      type: 'system' as const,
    }));
    await Notification.insertMany(notificationDocs, { ordered: false }).catch(() => undefined);

    // 2) Emit a realtime socket event to anyone currently connected.
    users.forEach((u) =>
      emitToUser(u._id.toString(), 'notification:broadcast', {
        title,
        message,
        timestamp: new Date(),
      }),
    );

    // 3) Fan out FCM pushes to every registered device token.
    const allTokens: string[] = [];
    const tokenToUser: Record<string, string> = {};
    users.forEach((u) => {
      (u.fcmTokens ?? []).forEach((t) => {
        if (t.token) {
          allTokens.push(t.token);
          tokenToUser[t.token] = u._id.toString();
        }
      });
    });

    let pushCount = 0;
    if (allTokens.length > 0) {
      // FCM sendEachForMulticast caps at 500 tokens per call.
      const chunks: string[][] = [];
      for (let i = 0; i < allTokens.length; i += 500) chunks.push(allTokens.slice(i, i + 500));

      const invalidTokens: string[] = [];
      for (const chunk of chunks) {
        const result = await sendPushToTokens(chunk, {
          title,
          body: message,
          data: { type: 'broadcast' },
        });
        pushCount += result.successCount;
        invalidTokens.push(...result.invalidTokens);
      }

      // Prune dead tokens so we don't keep retrying them.
      if (invalidTokens.length > 0) {
        const userIds = Array.from(new Set(invalidTokens.map((t) => tokenToUser[t]).filter(Boolean)));
        await User.updateMany(
          { _id: { $in: userIds } },
          { $pull: { fcmTokens: { token: { $in: invalidTokens } } } },
        );
      }
    }

    res.status(200).json({
      success: true,
      message: `Broadcast sent to ${users.length} users (${pushCount} push deliveries)`,
      data: { sentCount: users.length, pushCount, deviceCount: allTokens.length },
    });
  } catch (error) {
    console.error('broadcast error:', error);
    res.status(500).json({ success: false, message: 'Broadcast failed' });
  }
});

/**
 * POST /api/v1/admin/notify/:userId
 * Send notification to specific user
 */
router.post('/notify/:userId', requirePermission(PERMISSIONS.SEND_NOTIFICATIONS), auditLog({ action: 'notification.individual', resourceType: 'Notification' }), async (req: Request, res: Response) => {
  try {
    const { title, message, type } = req.body;

    if (!title || !message) {
      res.status(400).json({ success: false, message: 'Title and message are required' });
      return;
    }

    const user = await User.findById(req.params.userId).select('_id fcmTokens');
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    // 1) Persist for the in-app feed.
    await Notification.create({
      user: user._id,
      title,
      body: message,
      type: 'system',
    }).catch(() => undefined);

    // 2) Realtime socket event.
    emitToUser(user._id.toString(), 'notification:admin', {
      title,
      message,
      type: type || 'info',
      timestamp: new Date(),
    });

    // 3) FCM push to all the user's devices.
    const tokens = (user.fcmTokens ?? []).map((t) => t.token).filter(Boolean);
    let pushCount = 0;
    if (tokens.length > 0) {
      const result = await sendPushToTokens(tokens, {
        title,
        body: message,
        data: { type: type || 'admin' },
      });
      pushCount = result.successCount;
      if (result.invalidTokens.length > 0) {
        await User.updateOne(
          { _id: user._id },
          { $pull: { fcmTokens: { token: { $in: result.invalidTokens } } } },
        );
      }
    }

    res.status(200).json({
      success: true,
      message: 'Notification sent',
      data: { pushCount, deviceCount: tokens.length },
    });
  } catch (error) {
    console.error('notify user error:', error);
    res.status(500).json({ success: false, message: 'Notification failed' });
  }
});

/**
 * GET /api/v1/admin/notifications/sent
 * List notifications previously sent from the admin panel.
 * Notifications are grouped by (title, body, type) within a 1-minute bucket
 * so a single broadcast (which inserts one document per recipient) shows up
 * as a single row with a recipient count.
 *
 * Query params:
 *   - page (default 1), limit (default 20, max 100)
 *   - search (substring match on title/body, case-insensitive)
 */
router.get('/notifications/sent', requirePermission(PERMISSIONS.SEND_NOTIFICATIONS), async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const skip = (page - 1) * limit;
    const search = (req.query.search as string | undefined)?.trim();

    const match: Record<string, any> = {};
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      match.$or = [{ title: rx }, { body: rx }];
    }

    const pipeline: any[] = [
      ...(Object.keys(match).length ? [{ $match: match }] : []),
      {
        $group: {
          _id: {
            title: '$title',
            body: '$body',
            type: '$type',
            // Bucket by minute so a single broadcast collapses into one row.
            bucket: {
              $dateTrunc: { date: '$createdAt', unit: 'minute' },
            },
          },
          sentAt: { $min: '$createdAt' },
          recipientCount: { $sum: 1 },
          readCount: { $sum: { $cond: ['$isRead', 1, 0] } },
          sampleId: { $first: '$_id' },
        },
      },
      { $sort: { sentAt: -1 } },
      {
        $facet: {
          data: [
            { $skip: skip },
            { $limit: limit },
            {
              $project: {
                _id: '$sampleId',
                title: '$_id.title',
                body: '$_id.body',
                type: '$_id.type',
                sentAt: 1,
                recipientCount: 1,
                readCount: 1,
              },
            },
          ],
          totalArr: [{ $count: 'count' }],
        },
      },
    ];

    const [result] = await Notification.aggregate(pipeline);
    const items = result?.data ?? [];
    const total = result?.totalArr?.[0]?.count ?? 0;

    res.status(200).json({
      success: true,
      data: {
        notifications: items,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    console.error('list sent notifications error:', error);
    res.status(500).json({ success: false, message: 'Failed to list notifications' });
  }
});

// ════════════════════════════════════════════════════════════════════
// REPORTS / EXPORTS
// ════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/admin/reports/summary
 * Get comprehensive summary report
 */
router.get('/reports/summary', async (req: Request, res: Response) => {
  try {
    const { startDate, endDate } = req.query;
    const start = startDate ? new Date(startDate as string) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate as string) : new Date();

    const [
      newUsers,
      newDrivers,
      rideStats,
      revenueStats,
      topDrivers,
      topCustomers,
    ] = await Promise.all([
      User.countDocuments({ role: 'customer', createdAt: { $gte: start, $lte: end } }),
      User.countDocuments({ role: 'driver', createdAt: { $gte: start, $lte: end } }),
      Ride.aggregate([
        { $match: { createdAt: { $gte: start, $lte: end } } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
            totalFare: { $sum: '$actualFare' },
            avgFare: { $avg: '$actualFare' },
            totalDistance: { $sum: '$actualDistance' },
          },
        },
      ]),
      Payment.aggregate([
        { $match: { status: 'completed', createdAt: { $gte: start, $lte: end } } },
        {
          $group: {
            _id: '$type',
            total: { $sum: '$amount' },
            count: { $sum: 1 },
          },
        },
      ]),
      User.find({ role: 'driver' })
        .sort({ 'driverProfile.totalEarnings': -1 })
        .limit(5)
        .select('firstName lastName driverProfile.totalEarnings driverProfile.totalTrips driverProfile.rating'),
      Ride.aggregate([
        { $match: { status: 'completed', createdAt: { $gte: start, $lte: end } } },
        { $group: { _id: '$customer', rideCount: { $sum: 1 }, totalSpent: { $sum: '$actualFare' } } },
        { $sort: { totalSpent: -1 } },
        { $limit: 5 },
        {
          $lookup: {
            from: 'users',
            localField: '_id',
            foreignField: '_id',
            as: 'user',
          },
        },
        { $unwind: '$user' },
        {
          $project: {
            firstName: '$user.firstName',
            lastName: '$user.lastName',
            rideCount: 1,
            totalSpent: 1,
          },
        },
      ]),
    ]);

    res.status(200).json({
      success: true,
      data: {
        period: { start, end },
        users: { newCustomers: newUsers, newDrivers },
        rides: rideStats[0] || {},
        revenue: revenueStats,
        topDrivers,
        topCustomers,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Report generation failed' });
  }
});

export default router;
