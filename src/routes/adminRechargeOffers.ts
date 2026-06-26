import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { RechargeOffer } from '../models';
import { requirePermission } from '../middleware/auth';
import { auditLog } from '../middleware/audit';
import { PERMISSIONS } from '../config/permissions';

/**
 * Admin CRUD for wallet recharge offers. Mounted under /admin so it inherits
 * the authenticate + authorize('admin') middleware from routes/admin.ts.
 *
 * The customer app reads the active subset via GET /payments/recharge-offers.
 * Reuses the promo permissions since recharge offers are a promotional lever.
 */
const router = Router();

function parseOfferBody(body: any) {
  const out: any = {};
  if (body.amount !== undefined) out.amount = Number(body.amount);
  if (body.bonusAmount !== undefined) out.bonusAmount = Number(body.bonusAmount) || 0;
  if (body.discountPercent !== undefined) {
    out.discountPercent = Math.min(Math.max(Number(body.discountPercent) || 0, 0), 100);
  }
  if (body.label !== undefined) out.label = body.label ? String(body.label).trim() : '';
  if (body.isPopular !== undefined) out.isPopular = !!body.isPopular;
  if (body.isActive !== undefined) out.isActive = !!body.isActive;
  if (body.order !== undefined) out.order = Number(body.order) || 0;
  if (body.validFrom !== undefined) out.validFrom = body.validFrom ? new Date(body.validFrom) : null;
  if (body.validUntil !== undefined) out.validUntil = body.validUntil ? new Date(body.validUntil) : null;
  return out;
}

/** GET /admin/recharge-offers?isActive= — full list for the admin table. */
router.get(
  '/recharge-offers',
  requirePermission(PERMISSIONS.VIEW_PROMOS),
  async (req: Request, res: Response) => {
    try {
      const filter: any = {};
      const { isActive } = req.query;
      if (isActive === 'true') filter.isActive = true;
      if (isActive === 'false') filter.isActive = false;

      const offers = await RechargeOffer.find(filter).sort({ order: 1, amount: 1 });
      res.json({ success: true, data: { offers } });
    } catch (err) {
      console.error('[RechargeOffer] list error:', err);
      res.status(500).json({ success: false, message: 'Failed to load recharge offers' });
    }
  },
);

/** POST /admin/recharge-offers — create a new offer. */
router.post(
  '/recharge-offers',
  requirePermission(PERMISSIONS.MANAGE_PROMOS),
  auditLog({ action: 'recharge_offer.create', resourceType: 'RechargeOffer' }),
  async (req: Request, res: Response) => {
    try {
      const data = parseOfferBody(req.body || {});
      if (!data.amount || data.amount <= 0) {
        return res
          .status(400)
          .json({ success: false, message: 'amount must be greater than 0' });
      }
      const offer = await RechargeOffer.create(data);
      res.status(201).json({ success: true, data: { offer } });
    } catch (err) {
      console.error('[RechargeOffer] create error:', err);
      res.status(500).json({ success: false, message: 'Failed to create recharge offer' });
    }
  },
);

/** PATCH /admin/recharge-offers/:id — update an offer. */
router.patch(
  '/recharge-offers/:id',
  requirePermission(PERMISSIONS.MANAGE_PROMOS),
  auditLog({ action: 'recharge_offer.update', resourceType: 'RechargeOffer' }),
  async (req: Request, res: Response) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ success: false, message: 'Invalid offer id' });
      }
      const data = parseOfferBody(req.body || {});
      if (data.amount !== undefined && (!data.amount || data.amount <= 0)) {
        return res
          .status(400)
          .json({ success: false, message: 'amount must be greater than 0' });
      }
      const offer = await RechargeOffer.findByIdAndUpdate(req.params.id, data, {
        new: true,
        runValidators: true,
      });
      if (!offer) {
        return res.status(404).json({ success: false, message: 'Offer not found' });
      }
      res.json({ success: true, data: { offer } });
    } catch (err) {
      console.error('[RechargeOffer] update error:', err);
      res.status(500).json({ success: false, message: 'Failed to update recharge offer' });
    }
  },
);

/** DELETE /admin/recharge-offers/:id — remove an offer. */
router.delete(
  '/recharge-offers/:id',
  requirePermission(PERMISSIONS.MANAGE_PROMOS),
  auditLog({ action: 'recharge_offer.delete', resourceType: 'RechargeOffer' }),
  async (req: Request, res: Response) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ success: false, message: 'Invalid offer id' });
      }
      const offer = await RechargeOffer.findByIdAndDelete(req.params.id);
      if (!offer) {
        return res.status(404).json({ success: false, message: 'Offer not found' });
      }
      res.json({ success: true, message: 'Recharge offer deleted' });
    } catch (err) {
      console.error('[RechargeOffer] delete error:', err);
      res.status(500).json({ success: false, message: 'Failed to delete recharge offer' });
    }
  },
);

export default router;
