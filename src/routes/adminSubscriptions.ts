import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { SubscriptionPlan, UserSubscription, User } from '../models';
import { AuthRequest, requirePermission } from '../middleware/auth';
import { auditLog } from '../middleware/audit';
import { PERMISSIONS } from '../config/permissions';
import { emitToUser } from '../socket';

const router = Router();

const DAY_MS = 24 * 60 * 60 * 1000;

/** Shape a UserSubscription into the row the admin Subscribers tab expects. */
function mapSubscriber(sub: any) {
  const u = sub.user;
  const userObj = u
    ? {
        _id: u._id,
        name: [u.firstName, u.lastName].filter(Boolean).join(' ') || 'User',
        phone: u.phone,
      }
    : undefined;
  return {
    _id: sub._id,
    driver: sub.userType === 'driver' ? userObj : undefined,
    customer: sub.userType === 'customer' ? userObj : undefined,
    plan: sub.plan,
    status: sub.status,
    startDate: sub.startDate,
    endDate: sub.endDate,
    ridesUsed: sub.ridesUsed,
    autoRenew: sub.autoRenew,
  };
}

/** Normalise a plan's price to a monthly figure for MRR. */
function monthlyPrice(price: number, validityDays: number) {
  const days = validityDays || 30;
  return (price || 0) * (30 / days);
}

// ════════════════════════════════════════════════════════════════════
// SUBSCRIPTION PLANS (templates)
// ════════════════════════════════════════════════════════════════════

/** GET /api/v1/admin/subscription-plans — list plans with active-subscriber counts. */
router.get(
  '/subscription-plans',
  requirePermission(PERMISSIONS.VIEW_SUBSCRIPTIONS, PERMISSIONS.MANAGE_SUBSCRIPTIONS),
  async (req: Request, res: Response) => {
    try {
      const filter: Record<string, any> = {};
      if (req.query.target) filter.target = req.query.target;
      if (req.query.type) filter.type = req.query.type;
      if (req.query.isActive !== undefined) filter.isActive = req.query.isActive === 'true';

      const plans = await SubscriptionPlan.find(filter).sort({ createdAt: -1 }).lean();

      const counts = await UserSubscription.aggregate([
        { $match: { status: 'active' } },
        { $group: { _id: '$plan', count: { $sum: 1 } } },
      ]);
      const countMap = new Map(counts.map((c: any) => [String(c._id), c.count]));

      const data = plans.map((p) => ({
        ...p,
        subscriberCount: countMap.get(String(p._id)) ?? 0,
      }));

      res.json({ success: true, data });
    } catch (err) {
      console.error('[AdminSubscriptions] list plans error:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch plans' });
    }
  },
);

const PLAN_FIELDS = [
  'name',
  'type',
  'target',
  'price',
  'commissionRate',
  'rideLimit',
  'validityDays',
  'benefits',
  'isActive',
] as const;

/** POST /api/v1/admin/subscription-plans — create a plan. */
router.post(
  '/subscription-plans',
  requirePermission(PERMISSIONS.MANAGE_SUBSCRIPTIONS),
  auditLog({ action: 'subscription.plan.create', resourceType: 'SubscriptionPlan' }),
  async (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      if (!body.name || !String(body.name).trim()) {
        return res.status(400).json({ success: false, message: 'Plan name is required' });
      }
      const doc: Record<string, any> = {};
      for (const f of PLAN_FIELDS) if (f in body) doc[f] = body[f];
      doc.name = String(body.name).trim();
      if (body.rideLimit === undefined) doc.rideLimit = null;
      if (!Array.isArray(doc.benefits)) doc.benefits = [];

      const plan = await SubscriptionPlan.create(doc);
      res.status(201).json({ success: true, data: plan });
    } catch (err) {
      console.error('[AdminSubscriptions] create plan error:', err);
      res.status(500).json({ success: false, message: 'Failed to create plan' });
    }
  },
);

/** PATCH /api/v1/admin/subscription-plans/:id — update a plan. */
router.patch(
  '/subscription-plans/:id',
  requirePermission(PERMISSIONS.MANAGE_SUBSCRIPTIONS),
  auditLog({ action: 'subscription.plan.update', resourceType: 'SubscriptionPlan', resourceId: (req) => req.params.id }),
  async (req: Request, res: Response) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ success: false, message: 'Invalid plan id' });
      }
      const body = req.body || {};
      const updates: Record<string, any> = {};
      for (const f of PLAN_FIELDS) if (f in body) updates[f] = body[f];
      if ('name' in updates) updates.name = String(updates.name).trim();

      const plan = await SubscriptionPlan.findByIdAndUpdate(req.params.id, updates, {
        new: true,
        runValidators: true,
      });
      if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });
      res.json({ success: true, data: plan });
    } catch (err) {
      console.error('[AdminSubscriptions] update plan error:', err);
      res.status(500).json({ success: false, message: 'Failed to update plan' });
    }
  },
);

/** PATCH /api/v1/admin/subscription-plans/:id/toggle — activate / deactivate. */
router.patch(
  '/subscription-plans/:id/toggle',
  requirePermission(PERMISSIONS.MANAGE_SUBSCRIPTIONS),
  auditLog({ action: 'subscription.plan.toggle', resourceType: 'SubscriptionPlan', resourceId: (req) => req.params.id }),
  async (req: Request, res: Response) => {
    try {
      const plan = await SubscriptionPlan.findByIdAndUpdate(
        req.params.id,
        { isActive: !!req.body?.isActive },
        { new: true },
      );
      if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });
      res.json({ success: true, data: plan });
    } catch (err) {
      console.error('[AdminSubscriptions] toggle plan error:', err);
      res.status(500).json({ success: false, message: 'Failed to toggle plan' });
    }
  },
);

/** DELETE /api/v1/admin/subscription-plans/:id — remove a plan (blocked if it has active subscribers). */
router.delete(
  '/subscription-plans/:id',
  requirePermission(PERMISSIONS.MANAGE_SUBSCRIPTIONS),
  auditLog({ action: 'subscription.plan.delete', resourceType: 'SubscriptionPlan', resourceId: (req) => req.params.id }),
  async (req: Request, res: Response) => {
    try {
      const activeCount = await UserSubscription.countDocuments({
        plan: req.params.id,
        status: 'active',
      });
      if (activeCount > 0) {
        return res.status(409).json({
          success: false,
          message: `Cannot delete — ${activeCount} active subscriber(s) on this plan. Deactivate it instead.`,
        });
      }
      const plan = await SubscriptionPlan.findByIdAndDelete(req.params.id);
      if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });
      res.json({ success: true, message: 'Plan deleted' });
    } catch (err) {
      console.error('[AdminSubscriptions] delete plan error:', err);
      res.status(500).json({ success: false, message: 'Failed to delete plan' });
    }
  },
);

// ════════════════════════════════════════════════════════════════════
// SUBSCRIPTIONS (grants) — stats / revenue declared before /:id routes
// so the literal paths aren't captured by the :id param.
// ════════════════════════════════════════════════════════════════════

/** GET /api/v1/admin/subscriptions/stats — summary cards. */
router.get(
  '/subscriptions/stats',
  requirePermission(PERMISSIONS.VIEW_SUBSCRIPTIONS, PERMISSIONS.MANAGE_SUBSCRIPTIONS),
  async (_req: Request, res: Response) => {
    try {
      const now = new Date();
      const in7 = new Date(now.getTime() + 7 * DAY_MS);

      const [totalPlans, activePlans, totalSubscribers, activeSubscribers, expiringIn7Days, activeSubs] =
        await Promise.all([
          SubscriptionPlan.countDocuments({}),
          SubscriptionPlan.countDocuments({ isActive: true }),
          UserSubscription.countDocuments({}),
          UserSubscription.countDocuments({ status: 'active' }),
          UserSubscription.countDocuments({ status: 'active', endDate: { $gte: now, $lte: in7 } }),
          UserSubscription.find({ status: 'active' }).populate('plan', 'price validityDays').lean(),
        ]);

      const mrr = activeSubs.reduce((sum, s: any) => {
        const p = s.plan;
        return p ? sum + monthlyPrice(p.price, p.validityDays) : sum;
      }, 0);

      res.json({
        success: true,
        data: {
          totalPlans,
          activePlans,
          totalSubscribers,
          activeSubscribers,
          mrr: Math.round(mrr),
          expiringIn7Days,
        },
      });
    } catch (err) {
      console.error('[AdminSubscriptions] stats error:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch stats' });
    }
  },
);

/** GET /api/v1/admin/subscriptions/revenue — MRR + per-plan breakdown. */
router.get(
  '/subscriptions/revenue',
  requirePermission(PERMISSIONS.VIEW_SUBSCRIPTIONS, PERMISSIONS.MANAGE_SUBSCRIPTIONS),
  async (_req: Request, res: Response) => {
    try {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      const [plans, subs] = await Promise.all([
        SubscriptionPlan.find({}).lean(),
        UserSubscription.find({}).lean(),
      ]);

      const byPlan = plans.map((p) => {
        const planSubs = subs.filter((s: any) => String(s.plan) === String(p._id));
        const priceOf = (s: any) => (s.pricePaid != null ? s.pricePaid : p.price || 0);
        const activeCount = planSubs.filter((s: any) => s.status === 'active').length;
        const monthRevenue = planSubs
          .filter((s: any) => new Date(s.startDate) >= monthStart)
          .reduce((sum, s: any) => sum + priceOf(s), 0);
        const totalRevenue = planSubs.reduce((sum, s: any) => sum + priceOf(s), 0);
        return {
          planId: p._id,
          planName: p.name,
          type: p.type,
          activeCount,
          monthRevenue,
          totalRevenue,
          avgCommission: 0,
        };
      });

      const mrr = subs
        .filter((s: any) => s.status === 'active')
        .reduce((sum, s: any) => {
          const p = plans.find((pl) => String(pl._id) === String(s.plan));
          return p ? sum + monthlyPrice(p.price, p.validityDays) : sum;
        }, 0);

      const collectedThisMonth = byPlan.reduce((sum, r) => sum + r.monthRevenue, 0);
      const renewable = subs.filter((s: any) => ['active', 'expired'].includes(s.status)).length;
      const active = subs.filter((s: any) => s.status === 'active').length;
      const renewalRate = renewable ? Math.round((active / renewable) * 100) : 0;

      res.json({
        success: true,
        data: { mrr: Math.round(mrr), collectedThisMonth, renewalRate, byPlan },
      });
    } catch (err) {
      console.error('[AdminSubscriptions] revenue error:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch revenue' });
    }
  },
);

/** POST /api/v1/admin/subscriptions/grant — grant a plan to a user. */
router.post(
  '/subscriptions/grant',
  requirePermission(PERMISSIONS.MANAGE_SUBSCRIPTIONS),
  auditLog({ action: 'subscription.grant', resourceType: 'UserSubscription' }),
  async (req: AuthRequest, res: Response) => {
    try {
      const { userId, userType, planId, reason } = req.body || {};
      if (!mongoose.isValidObjectId(userId) || !mongoose.isValidObjectId(planId)) {
        return res.status(400).json({ success: false, message: 'Valid userId and planId are required' });
      }

      const [user, plan] = await Promise.all([User.findById(userId), SubscriptionPlan.findById(planId)]);
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });
      if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });

      const start = new Date();
      const end = new Date(start.getTime() + (plan.validityDays || 30) * DAY_MS);

      const sub = await UserSubscription.create({
        user: user._id,
        userType: userType || user.role,
        plan: plan._id,
        status: 'active',
        startDate: start,
        endDate: end,
        ridesUsed: 0,
        autoRenew: false,
        pricePaid: 0,
        grantedBy: req.user?._id,
        grantReason: reason,
      });

      emitToUser(String(user._id), 'subscription:granted', {
        planName: plan.name,
        message: `You've been granted the ${plan.name} plan. ${reason || ''}`.trim(),
      });

      res.status(201).json({ success: true, data: sub });
    } catch (err) {
      console.error('[AdminSubscriptions] grant error:', err);
      res.status(500).json({ success: false, message: 'Failed to grant subscription' });
    }
  },
);

/** POST /api/v1/admin/subscriptions/:id/cancel — cancel a grant. */
router.post(
  '/subscriptions/:id/cancel',
  requirePermission(PERMISSIONS.MANAGE_SUBSCRIPTIONS),
  auditLog({ action: 'subscription.cancel', resourceType: 'UserSubscription', resourceId: (req) => req.params.id }),
  async (req: Request, res: Response) => {
    try {
      const sub = await UserSubscription.findById(req.params.id);
      if (!sub) return res.status(404).json({ success: false, message: 'Subscription not found' });

      sub.status = 'cancelled';
      sub.cancellation = {
        reason: req.body?.reason || 'Cancelled by admin',
        cancelledAt: new Date(),
      };
      await sub.save();

      emitToUser(String(sub.user), 'subscription:cancelled', {
        message: `Your subscription has been cancelled. ${req.body?.reason || ''}`.trim(),
      });

      res.json({ success: true, data: sub });
    } catch (err) {
      console.error('[AdminSubscriptions] cancel error:', err);
      res.status(500).json({ success: false, message: 'Failed to cancel subscription' });
    }
  },
);

/** POST /api/v1/admin/subscriptions/:id/extend — push the end date out by N days. */
router.post(
  '/subscriptions/:id/extend',
  requirePermission(PERMISSIONS.MANAGE_SUBSCRIPTIONS),
  auditLog({ action: 'subscription.extend', resourceType: 'UserSubscription', resourceId: (req) => req.params.id }),
  async (req: Request, res: Response) => {
    try {
      const days = Number(req.body?.days);
      if (!days || days <= 0) {
        return res.status(400).json({ success: false, message: 'A positive number of days is required' });
      }
      const sub = await UserSubscription.findById(req.params.id);
      if (!sub) return res.status(404).json({ success: false, message: 'Subscription not found' });

      sub.endDate = new Date(new Date(sub.endDate).getTime() + days * DAY_MS);
      if (sub.status === 'expired') sub.status = 'active';
      await sub.save();

      res.json({ success: true, data: sub });
    } catch (err) {
      console.error('[AdminSubscriptions] extend error:', err);
      res.status(500).json({ success: false, message: 'Failed to extend subscription' });
    }
  },
);

/** GET /api/v1/admin/subscriptions — paginated subscribers list. */
router.get(
  '/subscriptions',
  requirePermission(PERMISSIONS.VIEW_SUBSCRIPTIONS, PERMISSIONS.MANAGE_SUBSCRIPTIONS),
  async (req: Request, res: Response) => {
    try {
      const page = Math.max(parseInt(req.query.page as string) || 1, 1);
      const limit = Math.min(parseInt(req.query.limit as string) || 10, 100);
      const filter: Record<string, any> = {};

      if (req.query.status) filter.status = req.query.status;
      if (req.query.planId && mongoose.isValidObjectId(req.query.planId as string)) {
        filter.plan = req.query.planId;
      }
      if (req.query.search) {
        const s = String(req.query.search);
        const matched = await User.find({
          $or: [
            { firstName: { $regex: s, $options: 'i' } },
            { lastName: { $regex: s, $options: 'i' } },
            { phone: { $regex: s, $options: 'i' } },
          ],
        }).select('_id');
        filter.user = { $in: matched.map((u) => u._id) };
      }

      const [subs, total] = await Promise.all([
        UserSubscription.find(filter)
          .populate('user', 'firstName lastName phone')
          .populate('plan')
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        UserSubscription.countDocuments(filter),
      ]);

      res.json({
        success: true,
        data: {
          subscribers: subs.map(mapSubscriber),
          pagination: { page, limit, total, pages: Math.ceil(total / limit) },
        },
      });
    } catch (err) {
      console.error('[AdminSubscriptions] subscribers error:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch subscribers' });
    }
  },
);

/** GET /api/v1/admin/subscriptions/:id — single subscriber. */
router.get(
  '/subscriptions/:id',
  requirePermission(PERMISSIONS.VIEW_SUBSCRIPTIONS, PERMISSIONS.MANAGE_SUBSCRIPTIONS),
  async (req: Request, res: Response) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ success: false, message: 'Invalid subscription id' });
      }
      const sub = await UserSubscription.findById(req.params.id)
        .populate('user', 'firstName lastName phone')
        .populate('plan')
        .lean();
      if (!sub) return res.status(404).json({ success: false, message: 'Subscription not found' });
      res.json({ success: true, data: mapSubscriber(sub) });
    } catch (err) {
      console.error('[AdminSubscriptions] subscriber error:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch subscriber' });
    }
  },
);

export default router;
