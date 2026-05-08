import { Router, Response } from 'express';
import mongoose from 'mongoose';
import { DriverIncentive, DriverIncentiveProgress } from '../models/DriverIncentive';
import { requirePermission, AuthRequest } from '../middleware/auth';
import { auditLog } from '../middleware/audit';
import { PERMISSIONS } from '../config/permissions';

const router = Router();

// ════════════════════════════════════════════════════════════════════
// LIST / CREATE
// ════════════════════════════════════════════════════════════════════

router.get(
  '/incentives',
  requirePermission(PERMISSIONS.VIEW_INCENTIVES),
  async (req: AuthRequest, res: Response) => {
    try {
      const filter: any = {};
      if (req.query.active === 'true') filter.active = true;
      if (req.query.active === 'false') filter.active = false;
      if (req.query.period) filter.period = req.query.period;
      if (req.query.target) filter.target = req.query.target;
      if (req.query.q) filter.name = new RegExp(String(req.query.q), 'i');

      const items = await DriverIncentive.find(filter)
        .populate('createdBy', 'firstName lastName')
        .populate('updatedBy', 'firstName lastName')
        .sort({ createdAt: -1 })
        .lean();
      res.json({ success: true, data: { items } });
    } catch (err) {
      console.error('[Incentives] list error:', err);
      res.status(500).json({ success: false, message: 'Failed to load incentives' });
    }
  }
);

router.post(
  '/incentives',
  requirePermission(PERMISSIONS.MANAGE_INCENTIVES),
  auditLog({ action: 'incentive.create', resourceType: 'incentive' }),
  async (req: AuthRequest, res: Response) => {
    try {
      const body = req.body || {};
      if (!body.name || !body.period || !body.target || body.threshold == null || !body.rewardType || body.rewardAmount == null) {
        return res.status(400).json({ success: false, message: 'Missing required fields' });
      }
      const doc = await DriverIncentive.create({
        ...body,
        createdBy: req.user?._id,
        updatedBy: req.user?._id,
      });
      res.status(201).json({ success: true, data: { incentive: doc } });
    } catch (err: any) {
      console.error('[Incentives] create error:', err);
      res.status(400).json({ success: false, message: err.message || 'Create failed' });
    }
  }
);

router.get(
  '/incentives/:id',
  requirePermission(PERMISSIONS.VIEW_INCENTIVES),
  async (req: AuthRequest, res: Response) => {
    try {
      const item = await DriverIncentive.findById(req.params.id)
        .populate('createdBy', 'firstName lastName')
        .populate('updatedBy', 'firstName lastName')
        .lean();
      if (!item) return res.status(404).json({ success: false, message: 'Not found' });

      const stats = await DriverIncentiveProgress.aggregate([
        { $match: { incentive: new mongoose.Types.ObjectId(req.params.id) } },
        {
          $group: {
            _id: null,
            totalProgressDocs: { $sum: 1 },
            earnedCount: { $sum: { $cond: ['$earned', 1, 0] } },
            paidOutCount: { $sum: { $cond: ['$paidOut', 1, 0] } },
            totalRewards: { $sum: '$rewardAmount' },
            totalPaidOut: { $sum: { $cond: ['$paidOut', '$rewardAmount', 0] } },
          },
        },
      ]);

      res.json({ success: true, data: { incentive: item, stats: stats[0] ?? null } });
    } catch (err) {
      console.error('[Incentives] get error:', err);
      res.status(500).json({ success: false, message: 'Failed to load' });
    }
  }
);

router.patch(
  '/incentives/:id',
  requirePermission(PERMISSIONS.MANAGE_INCENTIVES),
  auditLog({
    action: 'incentive.update',
    resourceType: 'incentive',
    resourceId: (req: AuthRequest) => req.params.id,
  }),
  async (req: AuthRequest, res: Response) => {
    try {
      const allowed = [
        'name',
        'description',
        'active',
        'period',
        'target',
        'threshold',
        'rewardType',
        'rewardAmount',
        'rideTypes',
        'vehicleTypes',
        'minRating',
        'driverIds',
        'startDate',
        'endDate',
      ];
      const update: any = { updatedBy: req.user?._id };
      for (const k of allowed) if (k in req.body) update[k] = req.body[k];

      const item = await DriverIncentive.findByIdAndUpdate(req.params.id, update, {
        new: true,
        runValidators: true,
      });
      if (!item) return res.status(404).json({ success: false, message: 'Not found' });
      res.json({ success: true, data: { incentive: item } });
    } catch (err: any) {
      console.error('[Incentives] update error:', err);
      res.status(400).json({ success: false, message: err.message || 'Update failed' });
    }
  }
);

router.delete(
  '/incentives/:id',
  requirePermission(PERMISSIONS.MANAGE_INCENTIVES),
  auditLog({
    action: 'incentive.delete',
    resourceType: 'incentive',
    resourceId: (req: AuthRequest) => req.params.id,
  }),
  async (req: AuthRequest, res: Response) => {
    try {
      const item = await DriverIncentive.findByIdAndDelete(req.params.id);
      if (!item) return res.status(404).json({ success: false, message: 'Not found' });
      res.json({ success: true });
    } catch (err) {
      console.error('[Incentives] delete error:', err);
      res.status(500).json({ success: false, message: 'Delete failed' });
    }
  }
);

// ════════════════════════════════════════════════════════════════════
// PROGRESS
// ════════════════════════════════════════════════════════════════════

router.get(
  '/incentives/:id/progress',
  requirePermission(PERMISSIONS.VIEW_INCENTIVES),
  async (req: AuthRequest, res: Response) => {
    try {
      const filter: any = { incentive: req.params.id };
      if (req.query.earned === 'true') filter.earned = true;
      if (req.query.paidOut === 'true') filter.paidOut = true;
      if (req.query.paidOut === 'false') filter.paidOut = false;
      if (req.query.periodKey) filter.periodKey = req.query.periodKey;
      if (req.query.driver) filter.driver = req.query.driver;

      const items = await DriverIncentiveProgress.find(filter)
        .populate('driver', 'firstName lastName phone driverProfile.vehicleNumber')
        .sort({ periodStart: -1, earned: -1, progress: -1 })
        .limit(500)
        .lean();
      res.json({ success: true, data: { items } });
    } catch (err) {
      console.error('[Incentives] progress error:', err);
      res.status(500).json({ success: false, message: 'Failed to load progress' });
    }
  }
);

router.get(
  '/incentives-progress',
  requirePermission(PERMISSIONS.VIEW_INCENTIVES),
  async (req: AuthRequest, res: Response) => {
    try {
      const filter: any = {};
      if (req.query.earned === 'true') filter.earned = true;
      if (req.query.paidOut === 'true') filter.paidOut = true;
      if (req.query.paidOut === 'false') filter.paidOut = false;
      if (req.query.driver) filter.driver = req.query.driver;
      if (req.query.periodKey) filter.periodKey = req.query.periodKey;

      const items = await DriverIncentiveProgress.find(filter)
        .populate('driver', 'firstName lastName phone')
        .populate('incentive', 'name period target threshold rewardType rewardAmount')
        .sort({ earnedAt: -1, periodStart: -1 })
        .limit(500)
        .lean();
      res.json({ success: true, data: { items } });
    } catch (err) {
      console.error('[Incentives] progress-all error:', err);
      res.status(500).json({ success: false, message: 'Failed to load progress' });
    }
  }
);

// ════════════════════════════════════════════════════════════════════
// PAYOUT
// ════════════════════════════════════════════════════════════════════

router.post(
  '/incentives/progress/:progressId/payout',
  requirePermission(PERMISSIONS.PAYOUT_INCENTIVES),
  auditLog({
    action: 'incentive.payout',
    resourceType: 'incentive_progress',
    resourceId: (req: AuthRequest) => req.params.progressId,
  }),
  async (req: AuthRequest, res: Response) => {
    try {
      const doc = await DriverIncentiveProgress.findById(req.params.progressId);
      if (!doc) return res.status(404).json({ success: false, message: 'Not found' });
      if (!doc.earned)
        return res.status(400).json({ success: false, message: 'Not yet earned' });
      if (doc.paidOut)
        return res.status(400).json({ success: false, message: 'Already paid out' });

      doc.paidOut = true;
      doc.paidOutAt = new Date();
      doc.paidOutBy = req.user?._id;
      if (req.body?.paymentRef) doc.paymentRef = String(req.body.paymentRef);
      if (req.body?.notes) doc.notes = String(req.body.notes);
      await doc.save();

      res.json({ success: true, data: { progress: doc } });
    } catch (err) {
      console.error('[Incentives] payout error:', err);
      res.status(500).json({ success: false, message: 'Payout failed' });
    }
  }
);

router.post(
  '/incentives/payout-bulk',
  requirePermission(PERMISSIONS.PAYOUT_INCENTIVES),
  auditLog({ action: 'incentive.payout_bulk', resourceType: 'incentive_progress' }),
  async (req: AuthRequest, res: Response) => {
    try {
      const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
      if (ids.length === 0)
        return res.status(400).json({ success: false, message: 'No ids provided' });

      const result = await DriverIncentiveProgress.updateMany(
        { _id: { $in: ids }, earned: true, paidOut: false },
        {
          $set: {
            paidOut: true,
            paidOutAt: new Date(),
            paidOutBy: req.user?._id,
            ...(req.body?.paymentRef ? { paymentRef: String(req.body.paymentRef) } : {}),
          },
        }
      );

      res.json({
        success: true,
        data: { matched: result.matchedCount, modified: result.modifiedCount },
      });
    } catch (err) {
      console.error('[Incentives] bulk payout error:', err);
      res.status(500).json({ success: false, message: 'Bulk payout failed' });
    }
  }
);

export default router;
