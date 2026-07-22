import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { Notification, User, Ride, Payment } from '../models';
import { authenticate, authorize, requirePermission } from '../middleware/auth';
import { auditLog } from '../middleware/audit';
import { PERMISSIONS } from '../config/permissions';
import { emitToUser } from '../socket';
import { sendPushToUser } from '../controllers/fcmController';

/**
 * The set of documents every driver must upload before their application
 * can be approved. Keep in sync with the driver app's DriverDetailsScreen.
 */
const REQUIRED_DRIVER_DOCS = [
  'licence',
  'aadhaar-front',
  'aadhaar-back',
  'profile-photo',
  'vehicle',
  'insurance',
] as const;

/**
 * Admin driver management endpoints — extends and (where useful) supersedes
 * the legacy inline routes in admin.ts. Mounted BEFORE the legacy routes so
 * specific paths (e.g. `/drivers/:id/rides`) win.
 *
 * Adds POST aliases for actions the admin UI expects, plus the previously
 * missing suspend/reactivate/commission/document-verify and a paginated
 * driver-rides endpoint.
 */
const router = Router();
router.use(authenticate);
router.use(authorize('admin'));

// ════════════════════════════════════════════════════════════════════
// GET /admin/drivers/:id/rides — paginated driver ride history
// ════════════════════════════════════════════════════════════════════
router.get(
  '/drivers/:id/rides',
  requirePermission(PERMISSIONS.VIEW_DRIVERS),
  async (req: Request, res: Response) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        res.status(400).json({ success: false, message: 'Invalid driver id' });
        return;
      }
      const page = parseInt(req.query.page as string) || 1;
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const status = req.query.status as string | undefined;

      const filter: Record<string, any> = { driver: req.params.id };
      if (status) filter.status = status;

      const [rides, total] = await Promise.all([
        Ride.find(filter)
          .populate('customer', 'firstName lastName phone avatar')
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit),
        Ride.countDocuments(filter),
      ]);

      res.status(200).json({
        success: true,
        data: {
          rides,
          pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
        },
      });
    } catch (error) {
      console.error('driver rides error:', error);
      res.status(500).json({ success: false, message: 'Failed to fetch driver rides' });
    }
  },
);

// ════════════════════════════════════════════════════════════════════
// GET /admin/drivers/:id/stats — earnings + ride counts breakdown
// ════════════════════════════════════════════════════════════════════
router.get(
  '/drivers/:id/stats',
  requirePermission(PERMISSIONS.VIEW_DRIVERS),
  async (req: Request, res: Response) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        res.status(400).json({ success: false, message: 'Invalid driver id' });
        return;
      }
      const driverId = new mongoose.Types.ObjectId(req.params.id);
      const now = Date.now();
      const week = new Date(now - 7 * 24 * 60 * 60 * 1000);
      const month = new Date(now - 30 * 24 * 60 * 60 * 1000);

      const [counts, earnings] = await Promise.all([
        Ride.aggregate([
          { $match: { driver: driverId } },
          {
            $group: {
              _id: '$status',
              count: { $sum: 1 },
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
          {
            $group: {
              _id: null,
              total: { $sum: '$amount' },
              thisWeek: {
                $sum: { $cond: [{ $gte: ['$createdAt', week] }, '$amount', 0] },
              },
              thisMonth: {
                $sum: { $cond: [{ $gte: ['$createdAt', month] }, '$amount', 0] },
              },
            },
          },
        ]),
      ]);

      const byStatus: Record<string, number> = {};
      counts.forEach((c) => (byStatus[c._id] = c.count));

      res.status(200).json({
        success: true,
        data: {
          rides: {
            total: Object.values(byStatus).reduce((a, b) => a + b, 0),
            byStatus,
          },
          earnings: earnings[0] || { total: 0, thisWeek: 0, thisMonth: 0 },
        },
      });
    } catch (error) {
      console.error('driver stats error:', error);
      res.status(500).json({ success: false, message: 'Failed to fetch stats' });
    }
  },
);

// ════════════════════════════════════════════════════════════════════
// POST aliases (the admin UI uses POST; legacy code uses PUT — keep both)
// ════════════════════════════════════════════════════════════════════

const approveHandler = async (req: Request, res: Response) => {
  try {
    // Gate: every required document must be uploaded AND admin-verified
    // before approval is allowed. Otherwise admin would be stamping the
    // driver as approved while one of their IDs is still pending review.
    const candidate = await User.findOne({
      _id: req.params.id,
      role: 'driver',
    });
    if (!candidate) {
      res.status(404).json({ success: false, message: 'Driver not found' });
      return;
    }
    const docs = candidate.driverProfile?.documents || [];
    // Legacy drivers (pre front/back split) stored a single combined "aadhaar"
    // doc. Treat a verified legacy doc as satisfying both aadhaar-front/back so
    // those drivers can still be approved.
    const legacyAadhaar = docs.find((d: any) => d.type === 'aadhaar');
    const missing: string[] = [];
    const unverified: string[] = [];
    for (const required of REQUIRED_DRIVER_DOCS) {
      let found = docs.find((d: any) => d.type === required);
      if (!found && (required === 'aadhaar-front' || required === 'aadhaar-back')) {
        found = legacyAadhaar;
      }
      if (!found) missing.push(required);
      else if (found.status !== 'verified') unverified.push(required);
    }
    if (missing.length > 0 || unverified.length > 0) {
      res.status(400).json({
        success: false,
        message: 'All driver documents must be uploaded and verified before approval.',
        data: { missing, unverified },
      });
      return;
    }

    const driver = await User.findOneAndUpdate(
      { _id: req.params.id, role: 'driver' },
      {
        // isVerified now means *phone OTP verified*, set during signup. The
        // admin-approved signal lives on driverProfile.registrationStep.
        isActive: true,
        'driverProfile.registrationStep': 'approved',
        $unset: { disabledAt: 1, disabledReason: 1 },
      },
      { new: true },
    );
    if (!driver) {
      res.status(404).json({ success: false, message: 'Driver not found' });
      return;
    }
    sendPushToUser(driver._id.toString(), {
      title: 'Application Approved',
      body: "Congratulations! You're approved. Tap to start driving.",
      data: { kind: 'application:approved' },
    }).catch((e) => console.warn('[approve] push failed:', e));
    await Notification.create({
      user: driver._id,
      title: 'You are approved! 🎉',
      body: 'Your driver application has been approved. Go online to start receiving bookings.',
      type: 'system',
    }).catch(() => {});
    emitToUser(driver._id.toString(), 'application:approved', {
      message:
        'Congratulations! Your driver application has been approved. You can now go online and accept rides.',
    });
    res.status(200).json({ success: true, data: { driver }, message: 'Driver approved' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Approval failed' });
  }
};
router.post(
  '/drivers/:id/approve',
  requirePermission(PERMISSIONS.APPROVE_DRIVERS),
  auditLog({ action: 'driver.approve', resourceType: 'User' }),
  approveHandler,
);

const rejectHandler = async (req: Request, res: Response) => {
  try {
    const { reason } = req.body || {};
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      res.status(400).json({ success: false, message: 'Rejection reason is required' });
      return;
    }
    const driver = await User.findOneAndUpdate(
      { _id: req.params.id, role: 'driver' },
      {
        // Keep isVerified as-is (it just means phone OTP verified). Mark
        // the application as rejected on the driverProfile. Deliberately NOT
        // isActive:false — that blocked OTP login outright, so a rejected
        // driver could never sign in to fix and resubmit their documents.
        'driverProfile.registrationStep': 'rejected',
        disabledReason: `Application rejected: ${reason}`,
      },
      { new: true },
    );
    if (!driver) {
      res.status(404).json({ success: false, message: 'Driver not found' });
      return;
    }
    emitToUser(driver._id.toString(), 'application:rejected', {
      reason,
      message: `Your driver application was not approved. Reason: ${reason}`,
    });
    sendPushToUser(driver._id.toString(), {
      title: 'Application update',
      body: `Your application was not approved: ${reason}. Fix your documents and resubmit.`,
      data: { kind: 'document:rejected' },
    }).catch((e) => console.warn('[reject] push failed:', e));
    await Notification.create({
      user: driver._id,
      title: 'Application not approved',
      body: `Reason: ${reason}. Update your documents from Profile → Documents and resubmit.`,
      type: 'system',
    }).catch(() => {});
    res.status(200).json({ success: true, message: 'Application rejected' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Rejection failed' });
  }
};
router.post(
  '/drivers/:id/reject',
  requirePermission(PERMISSIONS.APPROVE_DRIVERS),
  auditLog({ action: 'driver.reject', resourceType: 'User' }),
  rejectHandler,
);

const forceOfflineHandler = async (req: Request, res: Response) => {
  try {
    const { reason } = req.body || {};
    const driver = await User.findOneAndUpdate(
      { _id: req.params.id, role: 'driver' },
      { 'driverProfile.isOnline': false },
      { new: true },
    );
    if (!driver) {
      res.status(404).json({ success: false, message: 'Driver not found' });
      return;
    }
    emitToUser(driver._id.toString(), 'driver:force-offline', {
      reason,
      message: `You have been taken offline by admin.${reason ? ` Reason: ${reason}` : ''}`,
    });
    res.status(200).json({ success: true, message: 'Driver forced offline' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Operation failed' });
  }
};
router.post(
  '/drivers/:id/force-offline',
  requirePermission(PERMISSIONS.FORCE_OFFLINE),
  auditLog({ action: 'driver.force_offline', resourceType: 'User' }),
  forceOfflineHandler,
);

// ════════════════════════════════════════════════════════════════════
// SUSPEND / REACTIVATE
// ════════════════════════════════════════════════════════════════════
router.post(
  '/drivers/:id/suspend',
  requirePermission(PERMISSIONS.MANAGE_DRIVERS),
  auditLog({ action: 'driver.suspend', resourceType: 'User' }),
  async (req: Request, res: Response) => {
    try {
      const { reason, duration } = req.body || {};
      if (!reason) {
        res.status(400).json({ success: false, message: 'reason is required' });
        return;
      }
      const driver = await User.findOneAndUpdate(
        { _id: req.params.id, role: 'driver' },
        {
          isActive: false,
          disabledAt: new Date(),
          disabledReason: reason,
          'driverProfile.isOnline': false,
          // Revoke the session too — without this the suspended driver keeps
          // a working app session until their access token happens to expire.
          refreshToken: null,
        },
        { new: true },
      );
      if (!driver) {
        res.status(404).json({ success: false, message: 'Driver not found' });
        return;
      }
      emitToUser(driver._id.toString(), 'driver:suspended', {
        reason,
        duration,
        message: `Your account has been suspended. Reason: ${reason}`,
      });
      res
        .status(200)
        .json({ success: true, data: { driver }, message: 'Driver suspended' });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Suspension failed' });
    }
  },
);

router.post(
  '/drivers/:id/reactivate',
  requirePermission(PERMISSIONS.MANAGE_DRIVERS),
  auditLog({ action: 'driver.reactivate', resourceType: 'User' }),
  async (req: Request, res: Response) => {
    try {
      const driver = await User.findOneAndUpdate(
        { _id: req.params.id, role: 'driver' },
        {
          isActive: true,
          $unset: { disabledAt: 1, disabledReason: 1 },
        },
        { new: true },
      );
      if (!driver) {
        res.status(404).json({ success: false, message: 'Driver not found' });
        return;
      }
      emitToUser(driver._id.toString(), 'driver:reactivated', {
        message: 'Your account has been reactivated. You can resume accepting rides.',
      });
      res
        .status(200)
        .json({ success: true, data: { driver }, message: 'Driver reactivated' });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Reactivation failed' });
    }
  },
);

// ════════════════════════════════════════════════════════════════════
// PATCH /admin/drivers/:id/commission
// ════════════════════════════════════════════════════════════════════
router.patch(
  '/drivers/:id/commission',
  requirePermission(PERMISSIONS.MANAGE_DRIVERS),
  auditLog({ action: 'driver.update_commission', resourceType: 'User' }),
  async (req: Request, res: Response) => {
    try {
      const { commissionRate } = req.body || {};
      const rate = Number(commissionRate);
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
        res
          .status(400)
          .json({ success: false, message: 'commissionRate must be 0-100' });
        return;
      }
      const driver = await User.findOneAndUpdate(
        { _id: req.params.id, role: 'driver' },
        { 'driverProfile.commissionRate': rate },
        { new: true },
      );
      if (!driver) {
        res.status(404).json({ success: false, message: 'Driver not found' });
        return;
      }
      res.status(200).json({
        success: true,
        data: { driver },
        message: `Commission updated to ${rate}%`,
      });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Commission update failed' });
    }
  },
);

// ════════════════════════════════════════════════════════════════════
// PATCH /admin/drivers/:id/documents/:documentType/verify
// ════════════════════════════════════════════════════════════════════
router.patch(
  '/drivers/:id/documents/:documentType/verify',
  requirePermission(PERMISSIONS.APPROVE_DRIVERS),
  auditLog({ action: 'driver.verify_document', resourceType: 'User' }),
  async (req: Request, res: Response) => {
    try {
      const { status, note } = req.body || {};
      // Map admin UI's 'approved' to schema's 'verified' for backward compat.
      const normalized =
        status === 'approved' ? 'verified' : status;
      if (!['verified', 'rejected', 'pending'].includes(normalized)) {
        res
          .status(400)
          .json({ success: false, message: 'status must be verified|rejected|pending' });
        return;
      }
      const driver = await User.findById(req.params.id);
      if (!driver || driver.role !== 'driver' || !driver.driverProfile) {
        res.status(404).json({ success: false, message: 'Driver not found' });
        return;
      }
      const docs = driver.driverProfile.documents || [];
      const idx = docs.findIndex((d: any) => d.type === req.params.documentType);
      if (idx === -1) {
        res.status(404).json({ success: false, message: 'Document not found' });
        return;
      }
      docs[idx].status = normalized;
      driver.markModified('driverProfile.documents');
      if (
        normalized === 'rejected' &&
        (driver.driverProfile as any).registrationStep === 'pending'
      ) {
        // Surface the rejection as an application-level state so the app
        // flips from "waiting approval" to "fix your documents".
        (driver.driverProfile as any).registrationStep = 'rejected';
      }
      await driver.save();

      const niceType = req.params.documentType.replace(/-/g, ' ');
      const message =
        normalized === 'verified'
          ? `Your ${niceType} has been verified.`
          : `Your ${niceType} was ${normalized}${note ? `: ${note}` : ''}. Please re-upload it.`;

      emitToUser(driver._id.toString(), 'document:status', {
        documentType: req.params.documentType,
        status: normalized,
        note,
        message,
      });

      // Out-of-band push too — driver may not have the app open. Verified is
      // a quiet status update; rejection is the actionable one.
      if (normalized === 'rejected') {
        await Notification.create({
          user: driver._id,
          title: 'Document needs re-upload',
          body: message,
          type: 'system',
        }).catch(() => {});
        sendPushToUser(driver._id.toString(), {
          title: 'Document needs re-upload',
          body: message,
          data: {
            kind: 'document:rejected',
            documentType: req.params.documentType,
          },
        }).catch((e) => console.warn('[verify-doc] push failed:', e));
      }

      res.status(200).json({
        success: true,
        data: { document: docs[idx] },
        message: `Document ${normalized}`,
      });
    } catch (error) {
      console.error('verify document error:', error);
      res.status(500).json({ success: false, message: 'Verification failed' });
    }
  },
);

export default router;
