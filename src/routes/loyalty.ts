import { Router, Response } from 'express';
import mongoose from 'mongoose';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import {
  LoyaltyAccount,
  LoyaltyTier,
  LoyaltyTransaction,
  LoyaltyReward,
  LoyaltyRedemption,
} from '../models/Loyalty';
import { getOrCreateAccount, redeemReward, LoyaltyError } from '../services/loyaltyEngine';

const router = Router();
router.use(authenticate);
router.use(authorize('customer'));

/** GET /api/v1/loyalty/me — points, tier, next tier */
router.get('/me', async (req: AuthRequest, res: Response) => {
  try {
    const acct = await getOrCreateAccount(req.user!._id);
    const tiers = await LoyaltyTier.find({ active: true }).sort({ order: 1 }).lean();
    const currentTier = acct.tier ? tiers.find((t) => String(t._id) === String(acct.tier)) : null;
    const nextTier =
      tiers.find((t) => t.minLifetimePoints > acct.lifetimePoints) ?? null;

    res.json({
      success: true,
      data: {
        account: acct,
        currentTier,
        nextTier,
        pointsToNextTier: nextTier
          ? Math.max(0, nextTier.minLifetimePoints - acct.lifetimePoints)
          : 0,
      },
    });
  } catch (err) {
    console.error('[Loyalty me] error:', err);
    res.status(500).json({ success: false, message: 'Failed' });
  }
});

/** GET /api/v1/loyalty/transactions */
router.get('/transactions', async (req: AuthRequest, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const items = await LoyaltyTransaction.find({ user: req.user!._id })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    res.json({ success: true, data: { items } });
  } catch (err) {
    console.error('[Loyalty txns] error:', err);
    res.status(500).json({ success: false, message: 'Failed' });
  }
});

/** GET /api/v1/loyalty/rewards */
router.get('/rewards', async (req: AuthRequest, res: Response) => {
  try {
    const now = new Date();
    const items = await LoyaltyReward.find({
      active: true,
      $and: [
        { $or: [{ validFrom: { $exists: false } }, { validFrom: null }, { validFrom: { $lte: now } }] },
        { $or: [{ validUntil: { $exists: false } }, { validUntil: null }, { validUntil: { $gte: now } }] },
      ],
    })
      .sort({ pointsCost: 1 })
      .lean();
    res.json({ success: true, data: { items } });
  } catch (err) {
    console.error('[Loyalty rewards] error:', err);
    res.status(500).json({ success: false, message: 'Failed' });
  }
});

/** POST /api/v1/loyalty/redeem */
router.post('/redeem', async (req: AuthRequest, res: Response) => {
  try {
    const { rewardId } = req.body || {};
    if (typeof rewardId !== 'string' || !mongoose.isValidObjectId(rewardId)) {
      return res.status(400).json({ success: false, message: 'A valid rewardId is required' });
    }
    const result = await redeemReward({ userId: req.user!._id, rewardId });
    res.status(201).json({ success: true, data: result });
  } catch (err: any) {
    console.error('[Loyalty redeem] error:', err);
    // Only LoyaltyError carries text written for the customer. Every other
    // error is internal (cast/DB/network) — never echo its message back.
    if (err instanceof LoyaltyError) {
      return res.status(400).json({ success: false, message: err.message });
    }
    res
      .status(500)
      .json({ success: false, message: 'Could not redeem this reward. Please try again.' });
  }
});

/** GET /api/v1/loyalty/redemptions — my issued vouchers */
router.get('/redemptions', async (req: AuthRequest, res: Response) => {
  try {
    const items = await LoyaltyRedemption.find({ user: req.user!._id })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    res.json({ success: true, data: { items } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed' });
  }
});

export default router;
