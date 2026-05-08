import { Router, Response } from 'express';
import {
  LoyaltyTier,
  LoyaltyAccount,
  LoyaltyTransaction,
  LoyaltyReward,
  LoyaltyRedemption,
} from '../models/Loyalty';
import { requirePermission, AuthRequest } from '../middleware/auth';
import { auditLog } from '../middleware/audit';
import { PERMISSIONS } from '../config/permissions';
import { addTransaction, recalcTier, getOrCreateAccount } from '../services/loyaltyEngine';

const router = Router();

// ════════════════════════════════════════════════════════════════════
// TIERS
// ════════════════════════════════════════════════════════════════════

router.get(
  '/loyalty/tiers',
  requirePermission(PERMISSIONS.VIEW_LOYALTY),
  async (_req: AuthRequest, res: Response) => {
    const items = await LoyaltyTier.find().sort({ order: 1 }).lean();
    res.json({ success: true, data: { items } });
  }
);

router.post(
  '/loyalty/tiers',
  requirePermission(PERMISSIONS.MANAGE_LOYALTY),
  auditLog({ action: 'loyalty.tier.create', resourceType: 'loyalty_tier' }),
  async (req: AuthRequest, res: Response) => {
    try {
      const doc = await LoyaltyTier.create(req.body);
      res.status(201).json({ success: true, data: { tier: doc } });
    } catch (err: any) {
      res.status(400).json({ success: false, message: err.message || 'Create failed' });
    }
  }
);

router.patch(
  '/loyalty/tiers/:id',
  requirePermission(PERMISSIONS.MANAGE_LOYALTY),
  auditLog({
    action: 'loyalty.tier.update',
    resourceType: 'loyalty_tier',
    resourceId: (req: AuthRequest) => req.params.id,
  }),
  async (req: AuthRequest, res: Response) => {
    const allowed = [
      'name',
      'order',
      'minLifetimePoints',
      'perksDescription',
      'earnMultiplier',
      'rideDiscountPct',
      'active',
    ];
    const update: any = {};
    for (const k of allowed) if (k in req.body) update[k] = req.body[k];
    const doc = await LoyaltyTier.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!doc) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: { tier: doc } });
  }
);

router.delete(
  '/loyalty/tiers/:id',
  requirePermission(PERMISSIONS.MANAGE_LOYALTY),
  auditLog({
    action: 'loyalty.tier.delete',
    resourceType: 'loyalty_tier',
    resourceId: (req: AuthRequest) => req.params.id,
  }),
  async (req: AuthRequest, res: Response) => {
    const doc = await LoyaltyTier.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true });
  }
);

// ════════════════════════════════════════════════════════════════════
// REWARDS
// ════════════════════════════════════════════════════════════════════

router.get(
  '/loyalty/rewards',
  requirePermission(PERMISSIONS.VIEW_LOYALTY),
  async (req: AuthRequest, res: Response) => {
    const filter: any = {};
    if (req.query.active === 'true') filter.active = true;
    if (req.query.active === 'false') filter.active = false;
    if (req.query.type) filter.type = req.query.type;
    const items = await LoyaltyReward.find(filter).sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: { items } });
  }
);

router.post(
  '/loyalty/rewards',
  requirePermission(PERMISSIONS.MANAGE_LOYALTY),
  auditLog({ action: 'loyalty.reward.create', resourceType: 'loyalty_reward' }),
  async (req: AuthRequest, res: Response) => {
    try {
      const doc = await LoyaltyReward.create({ ...req.body, createdBy: req.user?._id });
      res.status(201).json({ success: true, data: { reward: doc } });
    } catch (err: any) {
      res.status(400).json({ success: false, message: err.message || 'Create failed' });
    }
  }
);

router.patch(
  '/loyalty/rewards/:id',
  requirePermission(PERMISSIONS.MANAGE_LOYALTY),
  auditLog({
    action: 'loyalty.reward.update',
    resourceType: 'loyalty_reward',
    resourceId: (req: AuthRequest) => req.params.id,
  }),
  async (req: AuthRequest, res: Response) => {
    const allowed = [
      'name',
      'description',
      'type',
      'pointsCost',
      'value',
      'maxRedemptionsPerUser',
      'totalRedemptionLimit',
      'validFrom',
      'validUntil',
      'minTierKey',
      'active',
      'imageUrl',
    ];
    const update: any = {};
    for (const k of allowed) if (k in req.body) update[k] = req.body[k];
    const doc = await LoyaltyReward.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!doc) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: { reward: doc } });
  }
);

router.delete(
  '/loyalty/rewards/:id',
  requirePermission(PERMISSIONS.MANAGE_LOYALTY),
  auditLog({
    action: 'loyalty.reward.delete',
    resourceType: 'loyalty_reward',
    resourceId: (req: AuthRequest) => req.params.id,
  }),
  async (req: AuthRequest, res: Response) => {
    const doc = await LoyaltyReward.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true });
  }
);

// ════════════════════════════════════════════════════════════════════
// ACCOUNTS / TRANSACTIONS
// ════════════════════════════════════════════════════════════════════

router.get(
  '/loyalty/accounts',
  requirePermission(PERMISSIONS.VIEW_LOYALTY),
  async (req: AuthRequest, res: Response) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
    const filter: any = {};
    if (req.query.tierKey) filter.tierKey = req.query.tierKey;
    if (req.query.user) filter.user = req.query.user;
    const items = await LoyaltyAccount.find(filter)
      .populate('user', 'firstName lastName phone email')
      .populate('tier', 'name key')
      .sort({ pointsBalance: -1 })
      .limit(limit)
      .lean();
    res.json({ success: true, data: { items } });
  }
);

router.get(
  '/loyalty/accounts/:userId',
  requirePermission(PERMISSIONS.VIEW_LOYALTY),
  async (req: AuthRequest, res: Response) => {
    const acct = await LoyaltyAccount.findOne({ user: req.params.userId })
      .populate('user', 'firstName lastName phone email')
      .populate('tier', 'name key minLifetimePoints earnMultiplier rideDiscountPct')
      .lean();
    if (!acct) return res.status(404).json({ success: false, message: 'No account' });

    const txns = await LoyaltyTransaction.find({ user: req.params.userId })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    const redemptions = await LoyaltyRedemption.find({ user: req.params.userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json({ success: true, data: { account: acct, transactions: txns, redemptions } });
  }
);

router.post(
  '/loyalty/accounts/:userId/adjust',
  requirePermission(PERMISSIONS.ADJUST_LOYALTY_POINTS),
  auditLog({
    action: 'loyalty.points.adjust',
    resourceType: 'loyalty_account',
    resourceId: (req: AuthRequest) => req.params.userId,
  }),
  async (req: AuthRequest, res: Response) => {
    try {
      const { points, description, reference } = req.body || {};
      const n = Number(points);
      if (!Number.isFinite(n) || n === 0) {
        return res.status(400).json({ success: false, message: 'points must be a non-zero number' });
      }
      const result = await addTransaction({
        userId: req.params.userId,
        type: n > 0 ? 'admin_credit' : 'admin_debit',
        points: n,
        description: description || (n > 0 ? 'Admin credit' : 'Admin debit'),
        reference,
        performedBy: req.user?._id,
      });
      res.json({ success: true, data: result });
    } catch (err: any) {
      res.status(400).json({ success: false, message: err.message || 'Adjust failed' });
    }
  }
);

router.post(
  '/loyalty/accounts/:userId/recalc-tier',
  requirePermission(PERMISSIONS.MANAGE_LOYALTY),
  auditLog({
    action: 'loyalty.tier.recalc',
    resourceType: 'loyalty_account',
    resourceId: (req: AuthRequest) => req.params.userId,
  }),
  async (req: AuthRequest, res: Response) => {
    const acct = await getOrCreateAccount(req.params.userId);
    await recalcTier(acct);
    res.json({ success: true, data: { account: acct } });
  }
);

// ════════════════════════════════════════════════════════════════════
// REDEMPTIONS
// ════════════════════════════════════════════════════════════════════

router.get(
  '/loyalty/redemptions',
  requirePermission(PERMISSIONS.VIEW_LOYALTY),
  async (req: AuthRequest, res: Response) => {
    const filter: any = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.user) filter.user = req.query.user;
    if (req.query.code) filter.code = String(req.query.code).toUpperCase();
    const items = await LoyaltyRedemption.find(filter)
      .populate('user', 'firstName lastName phone')
      .populate('reward', 'name type value pointsCost')
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();
    res.json({ success: true, data: { items } });
  }
);

router.post(
  '/loyalty/redemptions/:id/cancel',
  requirePermission(PERMISSIONS.MANAGE_LOYALTY),
  auditLog({
    action: 'loyalty.redemption.cancel',
    resourceType: 'loyalty_redemption',
    resourceId: (req: AuthRequest) => req.params.id,
  }),
  async (req: AuthRequest, res: Response) => {
    const doc = await LoyaltyRedemption.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: 'Not found' });
    if (doc.status !== 'issued')
      return res.status(400).json({ success: false, message: 'Only issued redemptions can be cancelled' });

    doc.status = 'cancelled';
    doc.cancelledAt = new Date();
    await doc.save();

    // Refund points
    try {
      await addTransaction({
        userId: doc.user,
        type: 'reverse',
        points: doc.rewardSnapshot.pointsCost,
        description: `Refund for cancelled redemption ${doc.code}`,
        reward: doc.reward,
        performedBy: req.user?._id,
      });
    } catch (err) {
      console.error('[Loyalty cancel] refund failed:', err);
    }

    res.json({ success: true, data: { redemption: doc } });
  }
);

// ════════════════════════════════════════════════════════════════════
// STATS
// ════════════════════════════════════════════════════════════════════

router.get(
  '/loyalty/stats',
  requirePermission(PERMISSIONS.VIEW_LOYALTY),
  async (_req: AuthRequest, res: Response) => {
    const [accountStats, byTier, redemptionStats] = await Promise.all([
      LoyaltyAccount.aggregate([
        {
          $group: {
            _id: null,
            totalAccounts: { $sum: 1 },
            totalPointsOutstanding: { $sum: '$pointsBalance' },
            totalLifetimePoints: { $sum: '$lifetimePoints' },
          },
        },
      ]),
      LoyaltyAccount.aggregate([
        { $match: { tier: { $ne: null } } },
        { $group: { _id: '$tierKey', count: { $sum: 1 } } },
      ]),
      LoyaltyRedemption.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
    ]);

    res.json({
      success: true,
      data: {
        ...(accountStats[0] ?? {
          totalAccounts: 0,
          totalPointsOutstanding: 0,
          totalLifetimePoints: 0,
        }),
        byTier,
        redemptionStats,
      },
    });
  }
);

export default router;
