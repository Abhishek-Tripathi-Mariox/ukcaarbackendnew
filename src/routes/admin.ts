import { Router, Request, Response } from 'express';
import { istDateStr } from '../utils/date';
import { User, Ride, Payment, Wallet, Chat, PromoCode, Notification } from '../models';
import { sendPushToTokens } from '../config/firebase';
import { authenticate, authorize, requirePermission } from '../middleware/auth';
import { auditLog } from '../middleware/audit';
import { PERMISSIONS } from '../config/permissions';
import { emitToUser, emitToRide } from '../socket';
import { clearAutoCancel } from '../controllers/rideController';
import { sendPushToUser } from '../controllers/fcmController';
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
import faqsRouter from './adminFaqs';
import rechargeOffersRouter from './adminRechargeOffers';
import subscriptionsRouter from './adminSubscriptions';

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
// FAQs (admin-managed help content for customer + driver apps)
router.use('/', faqsRouter);
// Wallet recharge offers (denominations + bonus/discount for the customer app)
router.use('/', rechargeOffersRouter);
// Subscription plans + grants (flexible plans for drivers / customers)
router.use('/', subscriptionsRouter);

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

    // Attach each user's average rating (received from drivers) so the admin
    // list can show a Rating column without a per-row request. One aggregation
    // covers the whole page.
    const userIds = users.map((u) => u._id);
    const ratingAgg = await Ride.aggregate([
      { $match: { customer: { $in: userIds }, 'rating.driverToCustomer': { $gte: 1 } } },
      {
        $group: {
          _id: '$customer',
          average: { $avg: '$rating.driverToCustomer' },
          count: { $sum: 1 },
        },
      },
    ]);
    const ratingByUser = new Map(
      ratingAgg.map((r: any) => [
        String(r._id),
        { average: Math.round(r.average * 100) / 100, count: r.count },
      ]),
    );
    const usersWithRating = users.map((u) => ({
      ...u.toObject(),
      rating: ratingByUser.get(String(u._id)) ?? { average: 0, count: 0 },
    }));

    res.status(200).json({
      success: true,
      data: { users: usersWithRating, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
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
      ratingStats,
      driverFeedback,
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
      // Ratings this user received from drivers (rating.driverToCustomer)
      Ride.aggregate([
        { $match: { ...rideMatch, 'rating.driverToCustomer': { $gte: 1 } } },
        {
          $group: {
            _id: null,
            average: { $avg: '$rating.driverToCustomer' },
            count: { $sum: 1 },
            five: { $sum: { $cond: [{ $eq: ['$rating.driverToCustomer', 5] }, 1, 0] } },
            four: { $sum: { $cond: [{ $eq: ['$rating.driverToCustomer', 4] }, 1, 0] } },
            three: { $sum: { $cond: [{ $eq: ['$rating.driverToCustomer', 3] }, 1, 0] } },
            two: { $sum: { $cond: [{ $eq: ['$rating.driverToCustomer', 2] }, 1, 0] } },
            one: { $sum: { $cond: [{ $eq: ['$rating.driverToCustomer', 1] }, 1, 0] } },
          },
        },
      ]),
      // Recent individual feedback entries from drivers
      Ride.find({ ...rideMatch, 'rating.driverToCustomer': { $gte: 1 } })
        .populate('driver', 'firstName lastName avatar')
        .select('rating createdAt updatedAt driver')
        .sort({ updatedAt: -1 })
        .limit(10),
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

    const rs = ratingStats[0];
    const rating = {
      average: rs?.average ? Math.round(rs.average * 100) / 100 : 0,
      count: rs?.count || 0,
      distribution: {
        5: rs?.five || 0,
        4: rs?.four || 0,
        3: rs?.three || 0,
        2: rs?.two || 0,
        1: rs?.one || 0,
      },
    };
    const feedback = (driverFeedback || []).map((r: any) => ({
      _id: r._id,
      stars: r.rating?.driverToCustomer ?? 0,
      comment: r.rating?.driverComment ?? '',
      tags: r.rating?.tags ?? [],
      driver: r.driver,
      date: r.updatedAt || r.createdAt,
    }));

    res.status(200).json({
      success: true,
      data: {
        user,
        rides,
        payments,
        wallet,
        rating,
        driverFeedback: feedback,
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
    // On suspension, also revoke the refresh token so any live session dies
    // as soon as its short-lived access token expires — otherwise the user
    // keeps a working session until they happen to log out.
    const update: Record<string, any> = { isActive };
    if (isActive === false) update.refreshToken = null;
    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true });
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
    // refreshToken: null — kill any live session along with the deactivation.
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { isActive: false, refreshToken: null },
      { new: true },
    );
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
// REFERRALS (refer & earn tracking)
// ════════════════════════════════════════════════════════════════════

/**
 * Reward paid to a referrer per successful referral, by the referrer's role.
 * Mirrors what the apps advertise (driver ₹200 / customer ₹400). Tweak here.
 */
const REFERRAL_REWARD = { driver: 200, customer: 400 };

/** Mongo $cond expr: pick reward rate from a referrer's role field. */
const rewardRateExpr = (roleField: string) => ({
  $cond: [{ $eq: [roleField, 'driver'] }, REFERRAL_REWARD.driver, REFERRAL_REWARD.customer],
});

/**
 * GET /api/v1/admin/referrals
 * Paginated list of referrers (users who referred at least one signup),
 * with referral counts and computed earnings, plus program-wide totals.
 */
router.get('/referrals', requirePermission(PERMISSIONS.VIEW_REFERRALS), async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '10'), 10) || 10));
    const search = String(req.query.search ?? '').trim();

    const searchMatch: any[] = [];
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      searchMatch.push({
        $match: {
          $or: [
            { 'referrer.firstName': rx },
            { 'referrer.lastName': rx },
            { 'referrer.phone': rx },
            { 'referrer.email': rx },
            { 'referrer.referralCode': rx },
          ],
        },
      });
    }

    const [listResult, summaryResult] = await Promise.all([
      User.aggregate([
        { $match: { referredBy: { $ne: null } } },
        { $group: { _id: '$referredBy', referredCount: { $sum: 1 }, lastReferralAt: { $max: '$createdAt' } } },
        { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'referrer' } },
        { $unwind: '$referrer' },
        ...searchMatch,
        {
          $addFields: {
            ratePerReferral: rewardRateExpr('$referrer.role'),
            earnings: { $multiply: ['$referredCount', rewardRateExpr('$referrer.role')] },
          },
        },
        { $sort: { referredCount: -1, lastReferralAt: -1 } },
        {
          $facet: {
            data: [
              { $skip: (page - 1) * limit },
              { $limit: limit },
              {
                $project: {
                  _id: 0,
                  referrerId: '$referrer._id',
                  firstName: '$referrer.firstName',
                  lastName: '$referrer.lastName',
                  phone: '$referrer.phone',
                  email: '$referrer.email',
                  avatar: '$referrer.avatar',
                  role: '$referrer.role',
                  referralCode: '$referrer.referralCode',
                  referredCount: 1,
                  ratePerReferral: 1,
                  earnings: 1,
                  lastReferralAt: 1,
                },
              },
            ],
            total: [{ $count: 'count' }],
          },
        },
      ]),
      User.aggregate([
        { $match: { referredBy: { $ne: null } } },
        { $group: { _id: '$referredBy', c: { $sum: 1 } } },
        { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'referrer' } },
        { $unwind: '$referrer' },
        {
          $group: {
            _id: null,
            totalReferrers: { $sum: 1 },
            totalReferred: { $sum: '$c' },
            totalEarnings: { $sum: { $multiply: ['$c', rewardRateExpr('$referrer.role')] } },
          },
        },
      ]),
    ]);

    const total = listResult[0]?.total[0]?.count ?? 0;
    const summary = summaryResult[0] || { totalReferrers: 0, totalReferred: 0, totalEarnings: 0 };

    res.status(200).json({
      success: true,
      data: {
        referrers: listResult[0]?.data ?? [],
        summary: {
          totalReferrers: summary.totalReferrers,
          totalReferred: summary.totalReferred,
          totalEarnings: summary.totalEarnings,
        },
        pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
      },
    });
  } catch (error) {
    console.error('[admin/referrals] error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch referrals' });
  }
});

/**
 * GET /api/v1/admin/referrals/:userId
 * Detail for one referrer: their info + the list of people they referred.
 */
router.get('/referrals/:userId', requirePermission(PERMISSIONS.VIEW_REFERRALS), async (req: Request, res: Response) => {
  try {
    const referrer = await User.findById(req.params.userId).select(
      'firstName lastName phone email avatar role referralCode createdAt'
    );
    if (!referrer) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    const referred = await User.find({ referredBy: referrer._id })
      .select('firstName lastName phone email avatar role isActive createdAt')
      .sort({ createdAt: -1 });

    const rate = referrer.role === 'driver' ? REFERRAL_REWARD.driver : REFERRAL_REWARD.customer;

    res.status(200).json({
      success: true,
      data: {
        referrer,
        ratePerReferral: rate,
        referredCount: referred.length,
        earnings: referred.length * rate,
        referred,
      },
    });
  } catch (error) {
    console.error('[admin/referrals/:userId] error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch referral detail' });
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
    const { isVerified, isOnline, isOnePass, search, minRating, serviceType, isActive } =
      req.query;

    const filter: Record<string, any> = { role: 'driver' };
    // isVerified=true now means "admin-approved" in the admin UI's vocabulary.
    // Translate it to registrationStep === 'approved' (the source of truth).
    if (isVerified !== undefined) {
      filter['driverProfile.registrationStep'] =
        isVerified === 'true' ? 'approved' : { $ne: 'approved' };
    }
    // Account active/suspended. The admin "Suspended" filter sends isActive=false.
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    if (isOnline !== undefined) filter['driverProfile.isOnline'] = isOnline === 'true';
    if (isOnePass !== undefined) filter['driverProfile.isOnePass'] = isOnePass === 'true';
    if (minRating) filter['driverProfile.rating'] = { $gte: parseFloat(minRating as string) };
    // Service category the driver registered for.
    if (
      typeof serviceType === 'string' &&
      ['instant', 'private', 'scheduled'].includes(serviceType)
    ) {
      filter['driverProfile.serviceType'] = serviceType;
    }
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
 * Project a populated ScheduledBooking (shuttle reservation) into a
 * Ride-shaped row so the admin Rides table renders it without any
 * frontend branching. `_id` carries a `sched_` prefix so the row key stays
 * unique against real Ride ids and the admin code can detect a booking row.
 */
function projectScheduledBooking(b: any) {
  const stops = b.route?.stops ?? [];
  const firstStop = stops[0];
  const lastStop = stops[stops.length - 1];
  const approvedDriverReg = (b.route?.registeredDrivers ?? []).find(
    (d: any) =>
      d?.status === 'approved' &&
      (typeof d.departureIndex !== 'number' || d.departureIndex === b.departureIndex),
  );
  const approvedDriver = approvedDriverReg?.driver ?? null;
  const departureSlot = b.route?.schedule?.departures?.[b.departureIndex];
  return {
    _id: `sched_${b._id}`,
    rideType: 'scheduled',
    isScheduled: true,
    scheduledAt: departureSlot
      ? `${b.departureDate}T${departureSlot.time ?? '00:00'}:00`
      : `${b.departureDate}T00:00:00`,
    // A reserved seat has no in-flight Ride status; we surface the booking's
    // own state ('reserved'/'cancelled') and the StatusBadge formatter
    // renders it directly.
    status: b.status === 'cancelled' ? 'cancelled' : 'reserved',
    pickup: firstStop
      ? { address: firstStop.name ?? firstStop.address ?? 'Stop 1', lat: firstStop.lat, lng: firstStop.lng }
      : null,
    dropoff: lastStop
      ? { address: lastStop.name ?? lastStop.address ?? 'Last stop', lat: lastStop.lat, lng: lastStop.lng }
      : null,
    customer: b.customer,
    driver: approvedDriver
      ? {
          _id: approvedDriver._id,
          firstName: approvedDriver.firstName,
          lastName: approvedDriver.lastName,
          phone: approvedDriver.phone,
          driverProfile: approvedDriver.driverProfile,
        }
      : null,
    estimatedFare: b.totalAmount,
    actualFare: b.totalAmount,
    paymentMethod: 'card',
    paymentStatus: 'completed',
    cancellation: b.cancellation?.cancelledAt
      ? {
          cancelledBy: b.cancellation.cancelledBy,
          reason: b.cancellation.reason,
          cancelledAt: b.cancellation.cancelledAt,
        }
      : undefined,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    booking: {
      route: b.route?._id ?? null,
      routeName: b.route?.name ?? null,
      departureDate: b.departureDate,
      departureIndex: b.departureIndex,
      departureTime: departureSlot?.time ?? null,
      seats: b.seats ?? [],
    },
  };
}

// Booking populate shape reused by every route that surfaces shuttle
// reservations as Ride-shaped rows.
const SCHEDULED_BOOKING_POPULATE = {
  path: 'route',
  select: 'name stops schedule registeredDrivers',
  populate: {
    path: 'registeredDrivers.driver',
    select: 'firstName lastName phone driverProfile.plateNumber',
  },
} as const;

/**
 * Translate the admin "ride type" category into Ride query clauses. The UI
 * groups rides the same way the table badge does — Instant / Private /
 * Scheduled — rather than by the free-form vehicle-code `rideType` field.
 *   instant   → on-demand ride that isn't private
 *   private   → rideType === 'private'
 *   scheduled → isScheduled === true
 * Any other value is treated as an exact vehicle-code match.
 */
function applyRideTypeCategory(filter: Record<string, any>, rideType?: string) {
  if (!rideType) return;
  if (rideType === 'scheduled') {
    filter.isScheduled = true;
  } else if (rideType === 'instant') {
    filter.rideType = { $ne: 'private' };
    filter.isScheduled = { $ne: true };
  } else {
    filter.rideType = rideType;
  }
}

/**
 * Build a MongoDB `$or` clause for the admin ride search box. Matches the
 * term against customer/driver name + phone (via a User lookup) and the
 * hex suffix of the ride id (the table shows the last 8 chars). Returns an
 * always-false clause when nothing matches so the search reads as "0 rows"
 * rather than "everything".
 */
async function buildRideSearchOr(term: string): Promise<Record<string, any>[]> {
  const t = term.trim();
  if (!t) return [];
  const userMatch = await User.find({
    $or: [
      { firstName: { $regex: t, $options: 'i' } },
      { lastName: { $regex: t, $options: 'i' } },
      { phone: { $regex: t, $options: 'i' } },
    ],
  })
    .select('_id')
    .lean();
  const userIds = userMatch.map((u: any) => u._id);
  const or: Record<string, any>[] = [];
  if (userIds.length) {
    or.push({ customer: { $in: userIds } });
    or.push({ driver: { $in: userIds } });
  }
  if (/^[a-f0-9]+$/i.test(t)) {
    or.push({ $expr: { $regexMatch: { input: { $toString: '$_id' }, regex: `${t}$`, options: 'i' } } });
  }
  // No name/phone/id match → force an empty result set.
  return or.length ? or : [{ _id: null }];
}

/**
 * GET /api/v1/admin/rides
 * List rides with advanced filters
 */
router.get('/rides', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const { status, rideType, startDate, endDate, customerId, driverId, paymentMethod, minFare, maxFare, search } = req.query;

    const filter: Record<string, any> = {};
    if (status) filter.status = status;
    applyRideTypeCategory(filter, rideType as string);
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
    // Free-text search over ride id / customer / driver. Resolved to a set
    // of customer + driver ids so the matched users' rides surface too.
    let searchUserIds: any[] | null = null;
    if (search && (search as string).trim()) {
      const t = (search as string).trim();
      const userMatch = await User.find({
        $or: [
          { firstName: { $regex: t, $options: 'i' } },
          { lastName: { $regex: t, $options: 'i' } },
          { phone: { $regex: t, $options: 'i' } },
        ],
      })
        .select('_id')
        .lean();
      searchUserIds = userMatch.map((u: any) => u._id);
      filter.$or = await buildRideSearchOr(t);
    }

    // Scheduled-shuttle reservations live in their own collection
    // (ScheduledBooking) because they don't carry a driver/dispatch
    // lifecycle the way instant Rides do. The admin Rides table is the
    // single place a staff member can find any booked trip, though, so
    // we also pull bookings here and shape them like Ride rows. Excluded
    // when the caller is filtering on instant-only attributes (driver,
    // paymentMethod, rideType) since none of those apply to a booking.
    const includeScheduled =
      !driverId &&
      !paymentMethod &&
      (!rideType || rideType === 'scheduled') &&
      (!status || status === 'searching' || status === 'cancelled');

    // Booking-side filter mirrors the ride filter where it makes sense.
    const bookingFilter: Record<string, any> = {};
    if (customerId) bookingFilter.customer = customerId;
    // Search restricts bookings to the matched customers (bookings have no
    // driver of their own and no queryable ride-id). No match → empty set.
    if (searchUserIds) {
      bookingFilter.customer = { $in: searchUserIds.length ? searchUserIds : [null] };
    }
    if (startDate || endDate) {
      bookingFilter.createdAt = {};
      if (startDate) bookingFilter.createdAt.$gte = new Date(startDate as string);
      if (endDate) bookingFilter.createdAt.$lte = new Date(endDate as string);
    }
    if (minFare || maxFare) {
      bookingFilter.totalAmount = {};
      if (minFare) bookingFilter.totalAmount.$gte = parseFloat(minFare as string);
      if (maxFare) bookingFilter.totalAmount.$lte = parseFloat(maxFare as string);
    }
    if (status === 'cancelled') {
      bookingFilter.status = 'cancelled';
    } else {
      // Default — surface active (reserved) bookings; cancelled appear only
      // when the admin explicitly filters by cancelled.
      bookingFilter.status = 'reserved';
    }

    const { ScheduledBooking } = await import('../models');

    const [rides, rideTotal, bookings, bookingTotal] = await Promise.all([
      Ride.find(filter)
        .populate('customer', 'firstName lastName phone')
        .populate('driver', 'firstName lastName phone')
        .sort({ createdAt: -1 })
        .lean(),
      Ride.countDocuments(filter),
      includeScheduled
        ? ScheduledBooking.find(bookingFilter)
            .populate('customer', 'firstName lastName phone')
            .populate(SCHEDULED_BOOKING_POPULATE)
            .sort({ createdAt: -1 })
            .lean()
        : Promise.resolve([] as any[]),
      includeScheduled ? ScheduledBooking.countDocuments(bookingFilter) : Promise.resolve(0),
    ]);

    const projectedBookings = (bookings as any[]).map(projectScheduledBooking);

    // Merge the two lists, sort by createdAt desc, then paginate
    // client-side over the merged set so admin sees a unified view.
    const combined = [...rides, ...projectedBookings].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    const pageStart = (page - 1) * limit;
    const paged = combined.slice(pageStart, pageStart + limit);
    const total = rideTotal + bookingTotal;

    res.status(200).json({
      success: true,
      data: {
        rides: paged,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    console.error('admin /rides error:', error);
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
 * Dedicated scheduled-rides view. Merges two sources into one table:
 *   1. Ride docs with `isScheduled: true` (instant rides booked for later)
 *   2. ScheduledBooking shuttle reservations (projected as Ride-shaped rows)
 *
 * Filters: status, rideType, paymentMethod, minFare/maxFare, startDate/endDate
 * (matched against the scheduled departure, not createdAt) and free-text
 * search. With no date filter the view defaults to upcoming departures.
 * Sorted by departure time ascending so the next trips sit at the top.
 */
router.get('/rides/scheduled', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const { status, rideType, paymentMethod, minFare, maxFare, startDate, endDate, search } = req.query;

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    // ── Ride side (isScheduled === true) ───────────────────────────────
    // Everything here is already scheduled, so the "ride type" category maps
    // to the kind of scheduled trip:
    //   instant   → pre-booked on-demand ride (not private)
    //   private   → pre-booked private ride
    //   scheduled → shuttle ScheduledBooking only (no real Ride docs)
    // 'reserved' status is a booking-only pseudo-status — both it and the
    // 'scheduled' type skip the Ride collection entirely.
    const skipRides = status === 'reserved' || rideType === 'scheduled';
    const rideFilter: Record<string, any> = { isScheduled: true };
    if (status && status !== 'reserved') rideFilter.status = status;
    if (rideType === 'private') rideFilter.rideType = 'private';
    else if (rideType === 'instant') rideFilter.rideType = { $ne: 'private' };
    if (paymentMethod) rideFilter.paymentMethod = paymentMethod;
    if (minFare || maxFare) {
      rideFilter.estimatedFare = {};
      if (minFare) rideFilter.estimatedFare.$gte = parseFloat(minFare as string);
      if (maxFare) rideFilter.estimatedFare.$lte = parseFloat(maxFare as string);
    }
    if (startDate || endDate) {
      rideFilter.scheduledAt = {};
      if (startDate) rideFilter.scheduledAt.$gte = new Date(startDate as string);
      if (endDate) rideFilter.scheduledAt.$lte = new Date(endDate as string);
    } else {
      rideFilter.scheduledAt = { $gte: startOfToday };
    }
    let searchUserIds: any[] | null = null;
    if (search && (search as string).trim()) {
      const t = (search as string).trim();
      const userMatch = await User.find({
        $or: [
          { firstName: { $regex: t, $options: 'i' } },
          { lastName: { $regex: t, $options: 'i' } },
          { phone: { $regex: t, $options: 'i' } },
        ],
      })
        .select('_id')
        .lean();
      searchUserIds = userMatch.map((u: any) => u._id);
      rideFilter.$or = await buildRideSearchOr(t);
    }

    // ── Booking side (shuttle reservations) ────────────────────────────
    // Bookings are always scheduled + card-paid; skip them when the admin
    // filters on an attribute a booking can't satisfy.
    const includeBookings =
      (!rideType || rideType === 'scheduled') &&
      (!paymentMethod || paymentMethod === 'card') &&
      (!status || status === 'reserved' || status === 'cancelled');

    const bookingFilter: Record<string, any> = {
      status: status === 'cancelled' ? 'cancelled' : 'reserved',
    };
    if (minFare || maxFare) {
      bookingFilter.totalAmount = {};
      if (minFare) bookingFilter.totalAmount.$gte = parseFloat(minFare as string);
      if (maxFare) bookingFilter.totalAmount.$lte = parseFloat(maxFare as string);
    }
    if (searchUserIds) {
      bookingFilter.customer = { $in: searchUserIds.length ? searchUserIds : [null] };
    }
    // departureDate is a 'YYYY-MM-DD' string — lexical compare works.
    if (startDate || endDate) {
      bookingFilter.departureDate = {};
      if (startDate) bookingFilter.departureDate.$gte = (startDate as string).slice(0, 10);
      if (endDate) bookingFilter.departureDate.$lte = (endDate as string).slice(0, 10);
    } else {
      bookingFilter.departureDate = { $gte: istDateStr() };
    }

    const { ScheduledBooking } = await import('../models');

    const [rides, bookings] = await Promise.all([
      skipRides
        ? Promise.resolve([] as any[])
        : Ride.find(rideFilter)
            .populate('customer', 'firstName lastName phone')
            .populate('driver', 'firstName lastName phone driverProfile.plateNumber')
            .lean(),
      includeBookings
        ? ScheduledBooking.find(bookingFilter)
            .populate('customer', 'firstName lastName phone')
            .populate(SCHEDULED_BOOKING_POPULATE)
            .lean()
        : Promise.resolve([] as any[]),
    ]);

    const projectedBookings = (bookings as any[]).map(projectScheduledBooking);

    // Merge and sort by departure time ascending (soonest first), then
    // paginate over the combined set.
    const combined = [...(rides as any[]), ...projectedBookings].sort(
      (a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime(),
    );
    const total = combined.length;
    const pageStart = (page - 1) * limit;
    const paged = combined.slice(pageStart, pageStart + limit);

    res.status(200).json({
      success: true,
      data: { rides: paged, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    });
  } catch (error) {
    console.error('admin /rides/scheduled error:', error);
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
      // Already-resolved disputes drop out of the queue.
      'dispute.resolved': { $ne: true },
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
      cancelledBy: 'admin',
      reason: reason || 'Cancelled by admin',
      fee: 0,
      cancelledAt: new Date(),
    };
    await ride.save();

    // Admin cancel pre-empts the 5-minute auto-cancel timer.
    clearAutoCancel(String(ride._id));

    // Notify both parties
    emitToUser(ride.customer.toString(), 'ride:cancelled', {
      rideId: String(ride._id),
      reason,
      cancelledBy: 'admin',
      message: `Your ride has been cancelled by support. ${reason || ''}`.trim(),
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
 * PUT /api/v1/admin/rides/scheduled/:bookingId/cancel
 * Admin-cancel a shuttle seat reservation (ScheduledBooking) with a reason.
 * These rows surface in the scheduled-rides tab with a `sched_`-prefixed id;
 * we tolerate either the raw or prefixed id. Flipping status→cancelled frees
 * the seats back into the pool (availability only counts 'reserved' rows).
 */
router.put('/rides/scheduled/:bookingId/cancel', requirePermission(PERMISSIONS.MANAGE_RIDES), auditLog({ action: 'booking.cancel', resourceType: 'ScheduledBooking' }), async (req: Request, res: Response) => {
  try {
    const { reason } = req.body;
    const cleanId = String(req.params.bookingId).replace(/^sched_/, '');

    const { ScheduledBooking } = await import('../models');
    const booking = await ScheduledBooking.findById(cleanId);
    if (!booking) {
      res.status(404).json({ success: false, message: 'Booking not found' });
      return;
    }
    if (booking.status === 'cancelled') {
      res.status(400).json({ success: false, message: 'Booking already cancelled' });
      return;
    }

    booking.status = 'cancelled';
    booking.cancellation = {
      cancelledBy: 'admin',
      reason: reason || 'Cancelled by admin',
      cancelledAt: new Date(),
    };
    await booking.save();

    // Refund wallet-paid bookings, mirroring the customer-facing cancel. Admin
    // cancels previously flipped status + freed seats but never refunded, so a
    // wallet-paying rider silently lost the fare when support cancelled.
    let walletBalanceAfter: number | undefined;
    if (booking.paymentMethod === 'wallet' && booking.totalAmount > 0) {
      const { Wallet, Payment } = await import('../models');
      const refunded = await Wallet.findOneAndUpdate(
        { user: booking.customer },
        { $inc: { balance: booking.totalAmount } },
        { new: true, upsert: true },
      );
      walletBalanceAfter = refunded.balance;
      try {
        await Payment.create({
          user: booking.customer,
          type: 'refund',
          amount: booking.totalAmount,
          method: 'wallet',
          status: 'completed',
          description: `Refund: admin-cancelled scheduled booking (${booking.seats.length} seat${booking.seats.length === 1 ? '' : 's'})`,
        });
      } catch (payErr) {
        console.warn('admin scheduled cancel: refund statement row failed:', payErr);
      }
    }

    emitToUser(booking.customer.toString(), 'booking:cancelled', {
      bookingId: String(booking._id),
      reason,
      cancelledBy: 'admin',
      message: `Your scheduled seat has been cancelled by support. ${reason || ''}`.trim(),
    });

    res.status(200).json({
      success: true,
      data: { booking, ...(walletBalanceAfter !== undefined && { walletBalance: walletBalanceAfter }) },
      message: 'Booking cancelled',
    });
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
 * GET /api/v1/admin/rides/:id/nearby-drivers?q=<name|phone>
 *
 * Returns online + active drivers within 7 km of this ride's pickup, with
 * an optional name/phone substring filter. Powers the "manually assign a
 * driver" picker on the ride detail page — admin types a name or last few
 * digits of a phone and we surface the matching nearby drivers.
 *
 * Why 7 km: same radius the customer's `/vehicle-types/nearby` and the
 * dispatcher's auto-fan-out use, so admin sees the same pool the system
 * would have picked from automatically.
 *
 * Why not $nearSphere: User schema stores driverProfile.currentLocation as
 * a plain {lat,lng} subdoc, not GeoJSON, so the 2dsphere index can't match
 * it. Haversine post-filter mirrors the other endpoints.
 */
router.get('/rides/:id/nearby-drivers', requirePermission(PERMISSIONS.MANAGE_RIDES), async (req: Request, res: Response) => {
  try {
    const ride = await Ride.findById(req.params.id).select('pickup status');
    if (!ride) {
      res.status(404).json({ success: false, message: 'Ride not found' });
      return;
    }

    const q = String(req.query.q ?? '').trim();
    const RADIUS_KM = 7;
    const pickupLat = ride.pickup.lat;
    const pickupLng = ride.pickup.lng;

    // Build the candidate filter. We deliberately keep this loose — admin
    // should also see drivers whose `isAvailable` flag wasn't toggled (the
    // existing dispatch path ignores it, see the comment in
    // vehicleTypeController.listNearbyVehicleTypes).
    const baseFilter: any = {
      role: 'driver',
      isActive: true,
      'driverProfile.isOnline': true,
    };
    if (q) {
      // Case-insensitive substring match on name or phone. We compile a
      // single regex so a query like "987" matches phone digits and
      // "raj" matches the first/last name.
      const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(safe, 'i');
      baseFilter.$or = [
        { firstName: re },
        { lastName: re },
        { phone: re },
      ];
    }

    const candidates = await User.find(baseFilter).select(
      '_id firstName lastName phone avatar driverProfile.currentLocation driverProfile.vehicleMake driverProfile.vehicleModel driverProfile.vehicleColor driverProfile.plateNumber driverProfile.vehicleTypeCode driverProfile.rating',
    );

    const KM_PER_DEG_LAT = 111;
    const kmPerDegLng = 111 * Math.cos((pickupLat * Math.PI) / 180) || 111;

    const nearby = candidates
      .filter(d => !!d.driverProfile?.currentLocation)
      .map(d => {
        const loc = d.driverProfile!.currentLocation!;
        const dLatKm = (loc.lat - pickupLat) * KM_PER_DEG_LAT;
        const dLngKm = (loc.lng - pickupLng) * kmPerDegLng;
        const distKm = Math.sqrt(dLatKm * dLatKm + dLngKm * dLngKm);
        return { d, distKm };
      })
      .filter(x => x.distKm <= RADIUS_KM)
      .sort((a, b) => a.distKm - b.distKm)
      .slice(0, 20)
      .map(({ d, distKm }) => ({
        _id: d._id,
        firstName: d.firstName,
        lastName: d.lastName,
        phone: d.phone,
        avatar: d.avatar,
        rating: d.driverProfile?.rating ?? 5.0,
        distanceKm: Math.round(distKm * 100) / 100,
        vehicle: {
          make: d.driverProfile?.vehicleMake,
          model: d.driverProfile?.vehicleModel,
          color: d.driverProfile?.vehicleColor,
          plate: d.driverProfile?.plateNumber,
          typeCode: d.driverProfile?.vehicleTypeCode,
        },
      }));

    res.status(200).json({
      success: true,
      data: { radiusKm: RADIUS_KM, drivers: nearby },
    });
  } catch (error) {
    console.error('admin nearby-drivers error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch nearby drivers' });
  }
});

/**
 * POST /api/v1/admin/rides/:id/assign-driver
 * Body: { driverId }
 *
 * Force-assigns the chosen driver to a still-searching ride. The customer
 * gets the same `ride:driver-assigned` event a normal driver-accept would
 * emit (so their FindingDriver screen navigates straight to RideTracking),
 * and the driver gets a `ride:assigned` event + a high-priority FCM push
 * so their app can jump to verify-OTP / ride-in-progress.
 *
 * This is meant for the "no driver picked up the request" recovery flow.
 * For ride-in-flight reassignment use PUT /rides/:id/reassign instead.
 */
router.post('/rides/:id/assign-driver', requirePermission(PERMISSIONS.MANAGE_RIDES), auditLog({ action: 'ride.admin_assign', resourceType: 'Ride' }), async (req: Request, res: Response) => {
  try {
    const { driverId } = req.body ?? {};
    if (!driverId) {
      res.status(400).json({ success: false, message: 'driverId is required' });
      return;
    }

    // Atomic claim with the same status guard normal acceptance uses —
    // protects against a real driver tapping Accept at the same moment.
    const claimed = await Ride.findOneAndUpdate(
      { _id: req.params.id, status: 'searching' },
      { $set: { driver: driverId, status: 'driver_assigned' } },
      { new: true },
    );
    if (!claimed) {
      res.status(400).json({ success: false, message: 'Ride is no longer searching' });
      return;
    }

    // Driver actually exists? If not, roll back to searching so we don't
    // strand the ride with a phantom driver.
    const driver = await User.findOne({ _id: driverId, role: 'driver' }).select(
      '_id firstName lastName phone avatar driverProfile',
    );
    if (!driver) {
      await Ride.updateOne(
        { _id: claimed._id },
        { $unset: { driver: '' }, $set: { status: 'searching' } },
      );
      res.status(404).json({ success: false, message: 'Driver not found' });
      return;
    }

    // Manual assignment over-rides the 5-minute auto-cancel timer and
    // dismisses any pending modals on other drivers that were originally
    // pinged for this ride.
    clearAutoCancel(String(claimed._id));

    // Populate customer + driver for the response/socket payload — the
    // customer's FindingDriver screen reads ride.driver.driverProfile.*
    const ride = await Ride.findById(claimed._id)
      .populate('customer', 'firstName lastName phone avatar')
      .populate(
        'driver',
        'firstName lastName phone avatar driverProfile.rating driverProfile.vehicleMake driverProfile.vehicleModel driverProfile.vehicleColor driverProfile.plateNumber driverProfile.totalTrips',
      );

    // ── Customer side ────────────────────────────────────────────────
    // Same event the regular accept flow emits. The customer's FindingDriver
    // screen already listens for this and navigates to RideTracking.
    emitToUser(String(claimed.customer), 'ride:driver-assigned', { ride });
    sendPushToUser(String(claimed.customer), {
      title: 'Driver assigned',
      body: 'Your ride has been assigned. Tap to track.',
      data: { kind: 'ride:driver-assigned', rideId: String(claimed._id) },
    }).catch(err => console.warn('[admin-assign] customer push failed:', err));

    // ── Driver side ──────────────────────────────────────────────────
    // The dispatch path (`ride:new-request`) shows the accept/reject modal.
    // Admin-assigned rides skip that — the driver should jump straight to
    // the verify-OTP screen because admin already accepted on their behalf.
    // Strip the OTP from the driver-facing payload (driver asks the
    // passenger, then types it back; they must NOT see it).
    const driverPayload = ride
      ? { ...ride.toObject(), pickupOtp: undefined }
      : null;
    emitToUser(String(driverId), 'ride:assigned', {
      rideId: String(claimed._id),
      ride: driverPayload,
      assignedBy: 'admin',
      message: 'Admin has assigned you a new ride.',
    });
    sendPushToUser(String(driverId), {
      title: 'New ride assigned',
      body: `Pickup: ${ride?.pickup?.address?.slice(0, 50) ?? 'See app'}`,
      data: {
        kind: 'ride:assigned',
        rideId: String(claimed._id),
      },
      android: { channelId: 'ukcaar_ride_alerts', priority: 'high' as const },
    }).catch(err => console.warn('[admin-assign] driver push failed:', err));

    res.status(200).json({
      success: true,
      data: { ride },
      message: 'Driver assigned',
    });
  } catch (error) {
    console.error('admin assign-driver error:', error);
    res.status(500).json({ success: false, message: 'Failed to assign driver' });
  }
});

/**
 * POST /api/v1/admin/rides/:id/verify-otp
 * Body: { otp }
 *
 * Admin-side OTP verification — same effect as the driver's verifyRideOtp
 * endpoint, but callable from the admin console. Useful while the driver
 * app's OTP flow isn't fully wired or for support reps confirming pickups
 * over a phone call. Flips the ride to in_progress, clears the OTP so it
 * can't be replayed, emits ride:status to both parties.
 */
router.post('/rides/:id/verify-otp', requirePermission(PERMISSIONS.MANAGE_RIDES), auditLog({ action: 'ride.admin_verify_otp', resourceType: 'Ride' }), async (req: Request, res: Response) => {
  try {
    const { otp } = req.body ?? {};
    if (!otp || !/^\d{4}$/.test(String(otp))) {
      res.status(400).json({ success: false, message: 'Enter the 4-digit OTP.' });
      return;
    }

    const ride = await Ride.findById(req.params.id);
    if (!ride) {
      res.status(404).json({ success: false, message: 'Ride not found' });
      return;
    }
    if (!ride.pickupOtp) {
      res.status(400).json({ success: false, message: 'OTP no longer required for this ride.' });
      return;
    }
    if (String(ride.pickupOtp) !== String(otp)) {
      res.status(400).json({ success: false, message: 'Incorrect OTP.' });
      return;
    }
    if (!['driver_assigned', 'driver_arriving', 'driver_arrived'].includes(ride.status)) {
      res.status(400).json({
        success: false,
        message: `Cannot start ride from status ${ride.status}.`,
      });
      return;
    }

    ride.pickupOtp = undefined;
    ride.status = 'in_progress';
    ride.startedAt = new Date();
    await ride.save();

    const populated = await Ride.findById(ride._id)
      .populate('customer', 'firstName lastName phone avatar')
      .populate(
        'driver',
        'firstName lastName phone avatar driverProfile.rating driverProfile.vehicleMake driverProfile.vehicleModel driverProfile.vehicleColor driverProfile.plateNumber driverProfile.totalTrips',
      );

    const statusPayload = {
      rideId: String(ride._id),
      status: 'in_progress',
      ride: populated,
    };
    emitToRide(String(ride._id), 'ride:status', statusPayload);
    emitToUser(String(ride.customer), 'ride:status', statusPayload);
    if (ride.driver) emitToUser(String(ride.driver), 'ride:status', statusPayload);

    // Push notifications for both parties so the apps wake even if
    // backgrounded.
    sendPushToUser(String(ride.customer), {
      title: 'Trip started',
      body: 'Your driver has started the trip. Sit back and enjoy the ride.',
      data: { kind: 'ride:status', rideId: String(ride._id), status: 'in_progress' },
    }).catch(err => console.warn('[admin-verify-otp] customer push failed:', err));
    if (ride.driver) {
      sendPushToUser(String(ride.driver), {
        title: 'Trip started',
        body: 'Trip has been verified and started by admin.',
        data: { kind: 'ride:status', rideId: String(ride._id), status: 'in_progress' },
      }).catch(err => console.warn('[admin-verify-otp] driver push failed:', err));
    }

    res.status(200).json({ success: true, data: { ride: populated }, message: 'Ride started' });
  } catch (error) {
    console.error('admin verify-otp error:', error);
    res.status(500).json({ success: false, message: 'OTP verification failed' });
  }
});

/**
 * POST /api/v1/admin/rides/:id/complete
 *
 * Admin-side ride completion. Mirrors what the driver's
 * `PUT /rides/:id/status` does for status='completed' — actual fare,
 * commission, driver-earnings credit + payment rows, driver-stat
 * increments. Pushed to both parties via ride:status.
 *
 * Used while we test the customer-side complete/receipt flow without
 * needing a driver app to drive the transition.
 */
router.post('/rides/:id/complete', requirePermission(PERMISSIONS.MANAGE_RIDES), auditLog({ action: 'ride.admin_complete', resourceType: 'Ride' }), async (req: Request, res: Response) => {
  try {
    const ride = await Ride.findById(req.params.id);
    if (!ride) {
      res.status(404).json({ success: false, message: 'Ride not found' });
      return;
    }
    if (ride.status === 'completed') {
      res.status(400).json({ success: false, message: 'Ride is already completed' });
      return;
    }
    if (ride.status === 'cancelled') {
      res.status(400).json({ success: false, message: 'Cannot complete a cancelled ride' });
      return;
    }

    ride.status = 'in_progress'; // satisfy any downstream invariants before final flip
    ride.status = 'completed';
    ride.completedAt = new Date();
    if (!ride.startedAt) ride.startedAt = new Date();
    ride.actualFare = ride.estimatedFare;
    ride.actualDistance = ride.estimatedDistance;
    ride.actualDuration = ride.estimatedDuration;

    // Same commission math the driver-driven path does. Kept duplicated
    // rather than refactored into a helper so the admin completion stays
    // visible — admins can audit exactly how the books were closed.
    const driverUser = await User.findById(ride.driver).select('driverProfile.isOnePass');
    const isOnePass = driverUser?.driverProfile?.isOnePass;
    const { getRideSettings } = await import('../utils/rideSettings');
    const rideSettings = await getRideSettings();
    const commissionRate = isOnePass
      ? rideSettings.onePassCommissionRate
      : rideSettings.commissionRate;
    ride.commission = Math.round(ride.actualFare * commissionRate * 100) / 100;
    ride.driverEarnings = Math.round(
      (ride.actualFare - ride.commission + (ride.tip || 0)) * 100,
    ) / 100;
    ride.paymentStatus = 'completed';

    if (ride.driver) {
      await User.findByIdAndUpdate(ride.driver, {
        $inc: {
          'driverProfile.totalTrips': 1,
          'driverProfile.totalEarnings': ride.driverEarnings,
        },
      });
    }

    await Payment.create({
      user: ride.customer,
      ride: ride._id,
      type: 'ride_payment',
      amount: ride.actualFare,
      method: ride.paymentMethod,
      status: 'completed',
      description: `Ride payment - ${ride.rideType}`,
    });
    if (ride.driver && ride.driverEarnings && ride.driverEarnings > 0) {
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
      if (ride.commission && ride.commission > 0) {
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

    await ride.save();

    const populated = await Ride.findById(ride._id)
      .populate('customer', 'firstName lastName phone avatar')
      .populate('driver', 'firstName lastName phone avatar driverProfile.rating driverProfile.vehicleMake driverProfile.vehicleModel driverProfile.vehicleColor driverProfile.plateNumber');

    const statusPayload = {
      rideId: String(ride._id),
      status: 'completed',
      ride: populated,
    };
    emitToRide(String(ride._id), 'ride:status', statusPayload);
    emitToUser(String(ride.customer), 'ride:status', statusPayload);
    if (ride.driver) emitToUser(String(ride.driver), 'ride:status', statusPayload);

    sendPushToUser(String(ride.customer), {
      title: 'Ride completed',
      body: `Trip complete. Fare: ₹${ride.actualFare.toFixed(2)}`,
      data: { kind: 'ride:status', rideId: String(ride._id), status: 'completed' },
    }).catch(err => console.warn('[admin-complete] customer push failed:', err));
    if (ride.driver) {
      sendPushToUser(String(ride.driver), {
        title: 'Ride completed',
        body: `Earnings credited: ₹${(ride.driverEarnings || 0).toFixed(2)}`,
        data: { kind: 'ride:status', rideId: String(ride._id), status: 'completed' },
      }).catch(err => console.warn('[admin-complete] driver push failed:', err));
    }

    res.status(200).json({ success: true, data: { ride: populated }, message: 'Ride completed' });
  } catch (error) {
    console.error('admin complete error:', error);
    res.status(500).json({ success: false, message: 'Failed to complete ride' });
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

/**
 * POST /api/v1/admin/rides/:id/resolve-dispute
 * Marks a flagged ride dispute as resolved. Optionally issues a refund to the
 * customer's wallet. The disputes queue (GET /rides/disputed) hides rides
 * whose dispute.resolved is true.
 */
router.post('/rides/:id/resolve-dispute', requirePermission(PERMISSIONS.RESOLVE_DISPUTE), auditLog({ action: 'ride.resolve_dispute', resourceType: 'Ride' }), async (req: Request, res: Response) => {
  try {
    const { resolution, refundAmount, notes } = req.body as {
      resolution?: string;
      refundAmount?: number;
      notes?: string;
    };

    const ride = await Ride.findById(req.params.id);
    if (!ride) {
      res.status(404).json({ success: false, message: 'Ride not found' });
      return;
    }

    const refund = Number(refundAmount) || 0;

    // Issue a wallet refund if requested. Mirrors the /payments/refund flow:
    // record a refund Payment and credit the customer's wallet (cash rides
    // can't be auto-refunded to a wallet, so we still log the intent).
    if (refund > 0) {
      await Payment.create({
        user: ride.customer,
        ride: ride._id,
        type: 'refund',
        amount: refund,
        method: ride.paymentMethod === 'cash' ? 'cash' : 'wallet',
        status: 'completed',
        description: `Dispute refund — ${resolution || 'admin resolution'}`,
      });

      if (ride.paymentMethod !== 'cash') {
        await Wallet.findOneAndUpdate(
          { user: ride.customer },
          { $inc: { balance: refund } },
          { upsert: true }
        );
      }
      ride.paymentStatus = 'refunded';
    }

    ride.dispute = {
      resolved: true,
      resolution,
      notes,
      refundAmount: refund,
      resolvedBy: (req as any).user?._id,
      resolvedAt: new Date(),
    };
    await ride.save();

    emitToUser(ride.customer.toString(), 'ride:dispute-resolved', {
      rideId: ride._id,
      resolution,
      refundAmount: refund,
      message: refund > 0
        ? `Your dispute was resolved with a ₹${refund.toFixed(2)} refund.`
        : 'Your dispute has been resolved.',
    });

    res.status(200).json({ success: true, data: { ride } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to resolve dispute' });
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
 * GET /api/v1/admin/promos/:id/usage
 * Detailed usage breakdown for a promo: totals, daily trend, and the most
 * recent redemptions. Rides record the promo by its `code` string, with the
 * applied discount in `ride.discount`.
 */
router.get('/promos/:id/usage', async (req: Request, res: Response) => {
  try {
    const promo = await PromoCode.findById(req.params.id);
    if (!promo) {
      res.status(404).json({ success: false, message: 'Promo not found' });
      return;
    }

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const match = { promoCode: promo.code };

    const [totals, byDay, recent, total] = await Promise.all([
      Ride.aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            uses: { $sum: 1 },
            totalDiscount: { $sum: '$discount' },
            uniqueCustomers: { $addToSet: '$customer' },
          },
        },
      ]),
      Ride.aggregate([
        { $match: match },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            uses: { $sum: 1 },
            discount: { $sum: '$discount' },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      Ride.find(match)
        .populate('customer', 'firstName lastName phone')
        .select('customer discount estimatedFare actualFare status createdAt')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Ride.countDocuments(match),
    ]);

    const summary = totals[0] || { uses: 0, totalDiscount: 0, uniqueCustomers: [] };

    res.status(200).json({
      success: true,
      data: {
        promo,
        summary: {
          uses: summary.uses,
          usedCount: promo.usedCount,
          totalDiscount: summary.totalDiscount,
          uniqueCustomers: summary.uniqueCustomers?.length ?? 0,
          remainingUses: Math.max(0, (promo.maxUses ?? 0) - (promo.usedCount ?? 0)),
        },
        byDay,
        recent,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch promo usage' });
  }
});

/**
 * POST /api/v1/admin/promos
 * Create a new promo code
 */
router.post('/promos', requirePermission(PERMISSIONS.MANAGE_PROMOS), auditLog({ action: 'promo.create', resourceType: 'PromoCode' }), async (req: Request, res: Response) => {
  try {
    const { code, type, value, maxUses, minFare, minRideAmount, maxDiscount, expiresAt, description } = req.body;

    if (!code || !type || value === undefined) {
      res.status(400).json({ success: false, message: 'Code, type, and value are required' });
      return;
    }

    const defaultExpiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

    const promo = await PromoCode.create({
      code: code.toUpperCase().replace(/\s/g, ''),
      type,
      value: Number(value) || 0,
      maxUses: Number(maxUses) || 100,
      minFare: Number(minFare ?? minRideAmount) || 0,
      maxDiscount: Number(maxDiscount) || 50,
      expiresAt: expiresAt ? new Date(expiresAt) : defaultExpiry,
      description: description || '',
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
 * GET /api/v1/admin/payments/payouts/pending
 * Drivers with outstanding cashout requests (Payment type 'cashout' still in
 * 'pending'). Grouped per driver so the queue shows one actionable row each.
 * NOTE: registered before /payments/:id so the literal path wins.
 */
router.get('/payments/payouts/pending', async (_req: Request, res: Response) => {
  try {
    const rows = await Payment.aggregate([
      { $match: { type: 'cashout', status: 'pending' } },
      {
        $group: {
          _id: '$user',
          pendingAmount: { $sum: '$amount' },
          ridesCount: { $sum: 1 },
        },
      },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'driver' } },
      { $unwind: '$driver' },
      {
        $project: {
          _id: 0,
          driverId: '$_id',
          driverName: {
            $trim: {
              input: {
                $concat: [
                  { $ifNull: ['$driver.firstName', ''] },
                  ' ',
                  { $ifNull: ['$driver.lastName', ''] },
                ],
              },
            },
          },
          driverEmail: '$driver.email',
          pendingAmount: 1,
          // Number of outstanding cashout requests for this driver.
          ridesCount: 1,
        },
      },
      { $sort: { pendingAmount: -1 } },
    ]);

    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch pending payouts' });
  }
});

/**
 * GET /api/v1/admin/payments/:id
 * Single payment detail. Must stay below the literal /payments/* routes above.
 */
router.get('/payments/:id', async (req: Request, res: Response) => {
  try {
    const payment = await Payment.findById(req.params.id)
      .populate('user', 'firstName lastName phone email role')
      .populate('ride', 'pickup.address dropoff.address estimatedFare actualFare status');
    if (!payment) {
      res.status(404).json({ success: false, message: 'Payment not found' });
      return;
    }
    res.status(200).json({ success: true, data: { payment } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch payment' });
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
 * POST /api/v1/admin/payments/payouts/process
 * Marks the pending cashout requests for the given drivers as completed
 * (i.e. the money has been sent out-of-band to their bank/UPI). The wallet
 * was already debited when the driver requested the cashout, so this only
 * settles the request status.
 */
router.post('/payments/payouts/process', requirePermission(PERMISSIONS.PROCESS_PAYOUTS), auditLog({ action: 'payout.process', resourceType: 'Payment' }), async (req: Request, res: Response) => {
  try {
    const { driverIds } = req.body as { driverIds?: string[] };
    if (!Array.isArray(driverIds) || driverIds.length === 0) {
      res.status(400).json({ success: false, message: 'driverIds is required' });
      return;
    }

    const result = await Payment.updateMany(
      { user: { $in: driverIds }, type: 'cashout', status: 'pending' },
      { $set: { status: 'completed' } }
    );

    driverIds.forEach((driverId) =>
      emitToUser(String(driverId), 'payout:processed', {
        message: 'Your cashout has been processed.',
      })
    );

    res.status(200).json({
      success: true,
      data: {
        processedDrivers: driverIds.length,
        processedPayments: result.modifiedCount,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to process payouts' });
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
 *
 * Source of truth for per-vehicle pricing is the VehicleType collection —
 * the same docs the customer's /rides/estimate reads via resolveRideRate.
 * We project each active type into the { base, perKm, perMin, minFare,
 * surgeMultiplier } shape the Fare Calculation page expects, falling back
 * to config.ride.baseFares for any field a vehicle type hasn't customised.
 */
router.get('/settings/fares', async (_req: Request, res: Response) => {
  try {
    const { VehicleType } = await import('../models');
    const { getRideSettings } = await import('../utils/rideSettings');
    const types = await VehicleType.find({ isActive: true })
      .sort({ sortOrder: 1, name: 1 })
      .select('code baseFare perKmFare perMinFare minFare pricingModel flatFare');

    const legacy = config.ride?.baseFares ?? {};
    const baseFares: Record<string, { base: number; perKm: number; perMin: number; minFare: number; surgeMultiplier: number; pricingModel: 'per_km' | 'subscription'; flatFare: number }> = {};
    for (const t of types) {
      const fallback = (legacy as any)[t.code] ?? (legacy as any).economy ?? { base: 0, perKm: 0, perMin: 0 };
      baseFares[t.code] = {
        base: Number.isFinite(t.baseFare) ? (t.baseFare as number) : fallback.base ?? 0,
        perKm: Number.isFinite(t.perKmFare) ? (t.perKmFare as number) : fallback.perKm ?? 0,
        perMin: Number.isFinite(t.perMinFare) ? (t.perMinFare as number) : fallback.perMin ?? 0,
        minFare: Number.isFinite(t.minFare) ? (t.minFare as number) : (config.ride?.minFare ?? 0),
        // Surge isn't yet per-vehicle on the model; surface 1.0 so the UI
        // input renders cleanly. Per-vehicle surge can be a follow-up.
        surgeMultiplier: 1.0,
        pricingModel: t.pricingModel === 'subscription' ? 'subscription' : 'per_km',
        flatFare: Number.isFinite(t.flatFare) ? (t.flatFare as number) : 0,
      };
    }

    const settings = await getRideSettings();
    res.status(200).json({
      success: true,
      data: {
        baseFares,
        commission: settings.commissionRate,
        cancellationFee: settings.cancellationFee,
        minFare: settings.minFare,
      },
    });
  } catch (error) {
    console.error('GET /settings/fares error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch fare settings' });
  }
});

/**
 * PATCH /api/v1/admin/settings/fares
 *
 * Persist per-vehicle fares to the VehicleType collection. This is what
 * /rides/estimate and ride creation read from, so saves take effect on
 * the very next estimate. After writing we clear the in-memory rate
 * cache in rideController so even cached entries are dropped.
 */
router.patch('/settings/fares', requirePermission(PERMISSIONS.MANAGE_SETTINGS), auditLog({ action: 'settings.update_fares', resourceType: 'Settings' }), async (req: Request, res: Response) => {
  try {
    const { baseFares, commission, cancellationFee, minFare } = req.body ?? {};
    if (!baseFares || typeof baseFares !== 'object') {
      res.status(400).json({ success: false, message: 'baseFares object is required' });
      return;
    }

    const { VehicleType, Settings } = await import('../models');
    const { clearRateCache } = await import('../controllers/rideController');
    const { getRideSettings, clearRideSettingsCache } = await import('../utils/rideSettings');

    const num = (v: any): number | undefined => {
      if (v === undefined || v === null || v === '') return undefined;
      const n = typeof v === 'number' ? v : parseFloat(String(v));
      return Number.isFinite(n) && n >= 0 ? n : undefined;
    };

    const codes = Object.keys(baseFares);
    await Promise.all(
      codes.map((code) => {
        const cfg = baseFares[code] ?? {};
        const updates: Record<string, any> = {};
        const base = num(cfg.base);
        const perKm = num(cfg.perKm);
        const perMin = num(cfg.perMin);
        const min = num(cfg.minFare);
        const flat = num(cfg.flatFare);
        if (base !== undefined) updates.baseFare = base;
        if (perKm !== undefined) updates.perKmFare = perKm;
        if (perMin !== undefined) updates.perMinFare = perMin;
        if (min !== undefined) updates.minFare = min;
        if (flat !== undefined) updates.flatFare = flat;
        if (cfg.pricingModel === 'subscription' || cfg.pricingModel === 'per_km') {
          updates.pricingModel = cfg.pricingModel;
        }
        if (Object.keys(updates).length === 0) return null;
        return VehicleType.updateOne({ code: String(code).toLowerCase() }, { $set: updates });
      }),
    );

    // Persist platform-wide money settings (commission / cancellation / min
    // fare) to the Settings singleton so they take effect on the next ride.
    // Commission arrives as a percentage (0–100) from the UI; store a fraction.
    const settingsUpdate: Record<string, number> = {};
    const commissionPct = num(commission);
    if (commissionPct !== undefined) {
      settingsUpdate.commissionRate = Math.min(commissionPct, 100) / 100;
    }
    const cancel = num(cancellationFee);
    if (cancel !== undefined) settingsUpdate.cancellationFee = cancel;
    const globalMin = num(minFare);
    if (globalMin !== undefined) settingsUpdate.minFare = globalMin;
    if (Object.keys(settingsUpdate).length > 0) {
      await Settings.updateOne(
        { key: 'platform' },
        { $set: { ...settingsUpdate, updatedBy: (req as any).user?._id } },
        { upsert: true },
      );
    }

    clearRateCache();
    clearRideSettingsCache();

    // Echo the freshly persisted state back so the admin page can refresh
    // without an extra GET round-trip.
    const types = await VehicleType.find({ isActive: true })
      .sort({ sortOrder: 1, name: 1 })
      .select('code baseFare perKmFare perMinFare minFare pricingModel flatFare');
    const legacy = config.ride?.baseFares ?? {};
    const echo: Record<string, any> = {};
    for (const t of types) {
      const fallback = (legacy as any)[t.code] ?? (legacy as any).economy ?? { base: 0, perKm: 0, perMin: 0 };
      echo[t.code] = {
        base: Number.isFinite(t.baseFare) ? t.baseFare : fallback.base ?? 0,
        perKm: Number.isFinite(t.perKmFare) ? t.perKmFare : fallback.perKm ?? 0,
        perMin: Number.isFinite(t.perMinFare) ? t.perMinFare : fallback.perMin ?? 0,
        minFare: Number.isFinite(t.minFare) ? t.minFare : (config.ride?.minFare ?? 0),
        surgeMultiplier: 1.0,
        pricingModel: t.pricingModel === 'subscription' ? 'subscription' : 'per_km',
        flatFare: Number.isFinite(t.flatFare) ? t.flatFare : 0,
      };
    }

    const settings = await getRideSettings(true);
    res.status(200).json({
      success: true,
      message: 'Fare configuration updated',
      data: {
        baseFares: echo,
        commission: settings.commissionRate,
        cancellationFee: settings.cancellationFee,
        minFare: settings.minFare,
      },
    });
  } catch (error) {
    console.error('PATCH /settings/fares error:', error);
    res.status(500).json({ success: false, message: 'Failed to update fare settings' });
  }
});

/**
 * GET /api/v1/admin/settings/general
 * Get general app settings
 */
// Defaults for the editable general settings. Any field the admin hasn't
// saved yet falls back to these so the form is never blank.
const GENERAL_SETTINGS_DEFAULTS = {
  appName: 'UKCAAR',
  supportEmail: 'support@ukcaar.com',
  supportPhone: '+44 800 123 4567',
  maxSearchRadius: 10, // km
  driverTimeout: 30, // seconds
  maintenanceMode: false,
  referralBonus: 0, // ₹ credited to a user who applies a referral code
};

// Static, non-editable extras the UI/consumers may read.
const GENERAL_SETTINGS_STATIC = {
  currency: 'INR',
  currencySymbol: '₹',
  rideTypes: ['economy', 'comfort', 'premium', 'xl', 'electric'],
  paymentMethods: ['card', 'cash', 'wallet'],
  onePassPrice: 99.99,
  onePassDuration: 30, // days
};

/** Merge the persisted Settings singleton over the defaults (ignoring unset fields). */
function buildGeneralSettings(doc: Record<string, any> | null) {
  const merged: Record<string, any> = { ...GENERAL_SETTINGS_DEFAULTS };
  if (doc) {
    for (const key of Object.keys(GENERAL_SETTINGS_DEFAULTS)) {
      if (doc[key] !== undefined && doc[key] !== null) merged[key] = doc[key];
    }
  }
  return { ...merged, ...GENERAL_SETTINGS_STATIC };
}

router.get('/settings/general', async (_req: Request, res: Response) => {
  try {
    const { Settings } = await import('../models');
    const doc = await Settings.findOne({ key: 'platform' }).lean();
    res.status(200).json({
      success: true,
      data: buildGeneralSettings(doc),
    });
  } catch (error) {
    console.error('GET /settings/general error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch settings' });
  }
});

/**
 * PATCH /api/v1/admin/settings/general
 * Persist the editable general settings to the Settings singleton.
 */
router.patch(
  '/settings/general',
  requirePermission(PERMISSIONS.MANAGE_SETTINGS),
  auditLog({ action: 'settings.update_general', resourceType: 'Settings' }),
  async (req: Request, res: Response) => {
    try {
      const { Settings } = await import('../models');
      const body = req.body ?? {};

      const update: Record<string, any> = {};
      if (body.appName !== undefined) update.appName = String(body.appName).trim();
      if (body.supportEmail !== undefined)
        update.supportEmail = String(body.supportEmail).trim();
      if (body.supportPhone !== undefined)
        update.supportPhone = String(body.supportPhone).trim();
      if (body.maxSearchRadius !== undefined) {
        const n = Number(body.maxSearchRadius);
        if (Number.isFinite(n)) update.maxSearchRadius = Math.min(Math.max(n, 1), 50);
      }
      if (body.driverTimeout !== undefined) {
        const n = Number(body.driverTimeout);
        if (Number.isFinite(n)) update.driverTimeout = Math.min(Math.max(n, 10), 120);
      }
      if (body.maintenanceMode !== undefined)
        update.maintenanceMode = !!body.maintenanceMode;
      if (body.referralBonus !== undefined) {
        const n = Number(body.referralBonus);
        if (Number.isFinite(n)) update.referralBonus = Math.max(0, n);
      }

      if (Object.keys(update).length === 0) {
        res.status(400).json({ success: false, message: 'No valid settings to update' });
        return;
      }

      const doc = await Settings.findOneAndUpdate(
        { key: 'platform' },
        { $set: { ...update, updatedBy: (req as any).user?._id } },
        { upsert: true, new: true },
      ).lean();

      res.status(200).json({
        success: true,
        message: 'General settings updated',
        data: buildGeneralSettings(doc),
      });
    } catch (error) {
      console.error('PATCH /settings/general error:', error);
      res.status(500).json({ success: false, message: 'Failed to update settings' });
    }
  },
);

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
 * Deliver a one-off admin notification to a single user across all three
 * channels: persisted in-app feed, realtime socket, and FCM push. Returns
 * delivery counts. Pruning of dead FCM tokens happens here too.
 */
async function deliverAdminNotification(
  user: { _id: any; fcmTokens?: { token: string }[] },
  title: string,
  message: string,
  type?: string,
) {
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

  return { pushCount, deviceCount: tokens.length };
}

/**
 * POST /api/v1/admin/notify/:userId
 * Send a notification to a specific user (by id). The admin UI resolves the
 * recipient via the user search (by mobile number + type) and then targets the
 * exact user picked from the results.
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

    const result = await deliverAdminNotification(user, title, message, type);

    res.status(200).json({
      success: true,
      message: 'Notification sent',
      data: result,
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
