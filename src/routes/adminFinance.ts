import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { parse } from 'csv-parse/sync';
import { Settlement, TaxInvoice, Payment, Ride, User } from '../models';
import { requirePermission } from '../middleware/auth';
import { auditLog } from '../middleware/audit';
import { PERMISSIONS } from '../config/permissions';
import {
  generateInvoiceNumber,
  buildCustomerInvoiceLines,
  buildDriverPayoutInvoice,
  invoicingDefaults,
} from '../services/invoicing';
import { streamInvoicePdf } from '../services/invoicePdf';

const router = Router();

// ════════════════════════════════════════════════════════════════════
// SETTLEMENTS / RAZORPAY RECONCILIATION
// ════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/admin/settlements
 * Paginated list, filterable by status, date range, UTR.
 */
router.get(
  '/settlements',
  requirePermission(PERMISSIONS.VIEW_SETTLEMENTS),
  async (req: Request, res: Response) => {
    try {
      const page = Math.max(parseInt(req.query.page as string) || 1, 1);
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const filter: any = {};
      if (req.query.status) filter.status = req.query.status;
      if (req.query.utr) filter.utr = req.query.utr;
      if (req.query.razorpayPaymentId) filter.razorpayPaymentId = req.query.razorpayPaymentId;
      if (req.query.startDate || req.query.endDate) {
        filter.createdAt = {};
        if (req.query.startDate) filter.createdAt.$gte = new Date(req.query.startDate as string);
        if (req.query.endDate) filter.createdAt.$lte = new Date(req.query.endDate as string);
      }

      const [items, total, agg] = await Promise.all([
        Settlement.find(filter)
          .populate('payment', 'amount status razorpayPaymentId user')
          .populate('ride', '_id actualFare estimatedFare')
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit),
        Settlement.countDocuments(filter),
        Settlement.aggregate([
          { $match: filter },
          {
            $group: {
              _id: '$status',
              count: { $sum: 1 },
              totalNet: { $sum: '$netAmount' },
            },
          },
        ]),
      ]);

      const summary: Record<string, { count: number; totalNet: number }> = {};
      agg.forEach((row) => {
        summary[row._id] = { count: row.count, totalNet: row.totalNet };
      });

      res.json({
        success: true,
        data: {
          items,
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
          summary,
        },
      });
    } catch (err) {
      console.error('[Settlements] list error:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch settlements' });
    }
  }
);

/**
 * POST /api/v1/admin/settlements/import
 * Import a Razorpay settlement report (JSON or CSV string in body).
 * Body: { source: 'csv'|'json', batchId?, data: string|array }
 *
 * Each row should map to: settlement_id, payment_id, order_id, utr,
 * amount, fee, tax, settled_amount, settled_at
 */
router.post(
  '/settlements/import',
  requirePermission(PERMISSIONS.RECONCILE_SETTLEMENTS),
  auditLog({ action: 'settlement.import', resourceType: 'Settlement' }),
  async (req: Request, res: Response) => {
    try {
      const { source = 'json', batchId, data } = req.body || {};
      if (!data) {
        res.status(400).json({ success: false, message: 'No data provided' });
        return;
      }

      let rows: any[] = [];
      if (source === 'csv') {
        rows = parse(data as string, { columns: true, skip_empty_lines: true, trim: true });
      } else if (Array.isArray(data)) {
        rows = data;
      } else {
        res.status(400).json({ success: false, message: 'Invalid data format' });
        return;
      }

      const generatedBatchId = batchId || `batch_${Date.now()}`;
      const results = { inserted: 0, updated: 0, skipped: 0, errors: [] as string[] };

      for (const row of rows) {
        try {
          const settlementId = String(
            row.settlement_id || row.razorpaySettlementId || row.id || ''
          ).trim();
          const paymentId = String(
            row.payment_id || row.razorpayPaymentId || ''
          ).trim() || undefined;
          const orderId = String(row.order_id || row.razorpayOrderId || '').trim() || undefined;
          if (!settlementId) {
            results.skipped++;
            continue;
          }
          const gross = Number(row.amount ?? row.grossAmount ?? 0);
          const fee = Number(row.fee ?? 0);
          const tax = Number(row.tax ?? 0);
          const net = Number(row.settled_amount ?? row.netAmount ?? gross - fee - tax);
          const settledAt = row.settled_at ? new Date(row.settled_at) : undefined;
          const utr = row.utr ? String(row.utr) : undefined;

          const existing = await Settlement.findOne({ razorpaySettlementId: settlementId, razorpayPaymentId: paymentId });
          if (existing) {
            existing.utr = utr ?? existing.utr;
            existing.grossAmount = gross;
            existing.fee = fee;
            existing.tax = tax;
            existing.netAmount = net;
            existing.settledAt = settledAt ?? existing.settledAt;
            existing.batchId = generatedBatchId;
            existing.reportSource = source === 'csv' ? 'csv_upload' : 'razorpay_api';
            existing.raw = row;
            await existing.save();
            results.updated++;
          } else {
            // Try to link to internal Payment + Ride
            let paymentRef: mongoose.Types.ObjectId | undefined;
            let rideRef: mongoose.Types.ObjectId | undefined;
            if (paymentId) {
              const p = await Payment.findOne({ razorpayPaymentId: paymentId }).select('_id ride');
              if (p) {
                paymentRef = p._id as any;
                if (p.ride) rideRef = p.ride as any;
              }
            }

            await Settlement.create({
              razorpaySettlementId: settlementId,
              razorpayPaymentId: paymentId,
              razorpayOrderId: orderId,
              utr,
              payment: paymentRef,
              ride: rideRef,
              grossAmount: gross,
              fee,
              tax,
              netAmount: net,
              currency: row.currency || 'INR',
              status: 'pending',
              batchId: generatedBatchId,
              reportSource: source === 'csv' ? 'csv_upload' : 'razorpay_api',
              settledAt,
              raw: row,
            });
            results.inserted++;
          }
        } catch (err: any) {
          results.errors.push(err.message || String(err));
        }
      }

      res.json({ success: true, data: { batchId: generatedBatchId, ...results } });
    } catch (err) {
      console.error('[Settlements] import error:', err);
      res.status(500).json({ success: false, message: 'Import failed' });
    }
  }
);

/**
 * POST /api/v1/admin/settlements/reconcile
 * Run reconciliation on pending settlements.
 * Compares Settlement.grossAmount with Payment.amount for matched payments.
 * Body: { batchId?, settlementIds?: [] }
 */
router.post(
  '/settlements/reconcile',
  requirePermission(PERMISSIONS.RECONCILE_SETTLEMENTS),
  auditLog({ action: 'settlement.reconcile', resourceType: 'Settlement' }),
  async (req: Request, res: Response) => {
    try {
      const { batchId, settlementIds } = req.body || {};
      const filter: any = { status: { $in: ['pending', 'mismatch'] } };
      if (batchId) filter.batchId = batchId;
      if (Array.isArray(settlementIds) && settlementIds.length) {
        filter._id = { $in: settlementIds.filter((id: string) => mongoose.isValidObjectId(id)) };
      }

      const settlements = await Settlement.find(filter).populate('payment', 'amount status razorpayPaymentId');
      const summary = { matched: 0, mismatch: 0, missing: 0, total: settlements.length };

      for (const s of settlements) {
        const payment: any = s.payment;
        if (!payment) {
          s.status = 'mismatch';
          s.mismatchReason = 'No matching internal payment';
          summary.missing++;
        } else {
          const expected = Number(payment.amount);
          const diff = Math.round((s.grossAmount - expected) * 100) / 100;
          s.expectedAmount = expected;
          s.diff = diff;
          if (Math.abs(diff) < 0.01) {
            s.status = 'matched';
            s.matchedAt = new Date();
            s.mismatchReason = undefined;
            summary.matched++;
          } else {
            s.status = 'mismatch';
            s.mismatchReason = `Amount diff: ${diff}`;
            summary.mismatch++;
          }
        }
        await s.save();
      }

      res.json({ success: true, data: summary });
    } catch (err) {
      console.error('[Settlements] reconcile error:', err);
      res.status(500).json({ success: false, message: 'Reconciliation failed' });
    }
  }
);

/**
 * PATCH /api/v1/admin/settlements/:id
 * Manually mark a settlement as reconciled / add notes.
 */
router.patch(
  '/settlements/:id',
  requirePermission(PERMISSIONS.RECONCILE_SETTLEMENTS),
  auditLog({ action: 'settlement.update', resourceType: 'Settlement', resourceId: (req) => req.params.id }),
  async (req: Request, res: Response) => {
    try {
      const allowed = ['status', 'notes', 'mismatchReason'] as const;
      const update: Record<string, any> = {};
      for (const k of allowed) {
        if (k in req.body) update[k] = req.body[k];
      }
      if (update.status === 'reconciled') update.matchedAt = new Date();
      const updated = await Settlement.findByIdAndUpdate(req.params.id, update, { new: true });
      if (!updated) {
        res.status(404).json({ success: false, message: 'Settlement not found' });
        return;
      }
      res.json({ success: true, data: { settlement: updated } });
    } catch (err) {
      console.error('[Settlements] update error:', err);
      res.status(500).json({ success: false, message: 'Update failed' });
    }
  }
);

// ════════════════════════════════════════════════════════════════════
// TAX INVOICES (GST + TDS)
// ════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/admin/invoices
 */
router.get(
  '/invoices',
  requirePermission(PERMISSIONS.MANAGE_INVOICES, PERMISSIONS.VIEW_PAYMENTS),
  async (req: Request, res: Response) => {
    try {
      const page = Math.max(parseInt(req.query.page as string) || 1, 1);
      const limit = Math.min(parseInt(req.query.limit as string) || 25, 100);
      const filter: any = {};
      if (req.query.type) filter.type = req.query.type;
      if (req.query.status) filter.status = req.query.status;
      if (req.query.customer) filter.customer = req.query.customer;
      if (req.query.driver) filter.driver = req.query.driver;
      if (req.query.ride) filter.ride = req.query.ride;
      if (req.query.invoiceNumber) filter.invoiceNumber = { $regex: req.query.invoiceNumber, $options: 'i' };
      if (req.query.startDate || req.query.endDate) {
        filter.createdAt = {};
        if (req.query.startDate) filter.createdAt.$gte = new Date(req.query.startDate as string);
        if (req.query.endDate) filter.createdAt.$lte = new Date(req.query.endDate as string);
      }

      const [items, total] = await Promise.all([
        TaxInvoice.find(filter)
          .populate('customer', 'firstName lastName email phone')
          .populate('driver', 'firstName lastName phone')
          .populate('ride', '_id pickup dropoff')
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit),
        TaxInvoice.countDocuments(filter),
      ]);

      res.json({
        success: true,
        data: { items, page, limit, total, pages: Math.ceil(total / limit) },
      });
    } catch (err) {
      console.error('[Invoices] list error:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch invoices' });
    }
  }
);

/**
 * GET /api/v1/admin/invoices/:id
 */
router.get(
  '/invoices/:id',
  requirePermission(PERMISSIONS.MANAGE_INVOICES, PERMISSIONS.VIEW_PAYMENTS),
  async (req: Request, res: Response) => {
    try {
      const inv = await TaxInvoice.findById(req.params.id)
        .populate('customer', 'firstName lastName email phone')
        .populate('driver', 'firstName lastName phone')
        .populate('ride')
        .populate('payment');
      if (!inv) {
        res.status(404).json({ success: false, message: 'Invoice not found' });
        return;
      }
      res.json({ success: true, data: { invoice: inv } });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Failed to fetch invoice' });
    }
  }
);

/**
 * GET /api/v1/admin/invoices/:id/pdf
 * Stream PDF for an invoice.
 */
router.get(
  '/invoices/:id/pdf',
  requirePermission(PERMISSIONS.MANAGE_INVOICES, PERMISSIONS.VIEW_PAYMENTS),
  async (req: Request, res: Response) => {
    try {
      const inv = await TaxInvoice.findById(req.params.id);
      if (!inv) {
        res.status(404).json({ success: false, message: 'Invoice not found' });
        return;
      }
      streamInvoicePdf(inv, res);
    } catch (err) {
      console.error('[Invoices] pdf error:', err);
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: 'PDF generation failed' });
      }
    }
  }
);

/**
 * POST /api/v1/admin/invoices/customer
 * Generate a customer GST invoice for a ride.
 * Body: { rideId, receiverName?, receiverGstin?, receiverState?, receiverAddress?, issue? }
 */
router.post(
  '/invoices/customer',
  requirePermission(PERMISSIONS.MANAGE_INVOICES),
  auditLog({ action: 'invoice.create_customer', resourceType: 'TaxInvoice' }),
  async (req: Request, res: Response) => {
    try {
      const { rideId, receiverName, receiverGstin, receiverState, receiverAddress, issue } = req.body || {};
      if (!rideId || !mongoose.isValidObjectId(rideId)) {
        res.status(400).json({ success: false, message: 'Valid rideId required' });
        return;
      }

      const ride = await Ride.findById(rideId).populate('customer', 'firstName lastName email phone');
      if (!ride) {
        res.status(404).json({ success: false, message: 'Ride not found' });
        return;
      }
      const fareAmount = ride.actualFare ?? ride.estimatedFare ?? 100;
      if (fareAmount <= 0) {
        res.status(400).json({ success: false, message: 'Ride has no fare amount' });
        return;
      }

      const cust: any = ride.customer;
      const lines = buildCustomerInvoiceLines({
        rideAmount: fareAmount,
        receiverName: receiverName || (cust ? `${cust.firstName || ''} ${cust.lastName || ''}`.trim() : undefined),
        receiverGstin,
        receiverState,
        receiverAddress,
        rideId: String(ride._id),
        customerId: cust?._id?.toString(),
        description: `Ride from ${ride.pickup.address} to ${ride.dropoff.address}`,
      });

      const invoiceNumber = await generateInvoiceNumber('customer');
      const payment = await Payment.findOne({ ride: ride._id, type: 'ride_payment' }).select('_id');

      const invoice = await TaxInvoice.create({
        invoiceNumber,
        type: 'customer',
        status: issue ? 'issued' : 'draft',
        customer: cust?._id,
        ride: ride._id,
        payment: payment?._id,
        ...invoicingDefaults,
        receiverName: lines && (receiverName || (cust ? `${cust.firstName || ''} ${cust.lastName || ''}`.trim() : '')),
        receiverGstin,
        receiverAddress,
        receiverState,
        isInterState: lines.isInterState,
        placeOfSupply: receiverState,
        lineItems: lines.lineItems,
        subTotal: lines.subTotal,
        totalCgst: lines.totalCgst,
        totalSgst: lines.totalSgst,
        totalIgst: lines.totalIgst,
        totalTax: lines.totalTax,
        totalAmount: lines.totalAmount,
        issuedAt: issue ? new Date() : undefined,
        createdBy: (req as any).user?._id,
      });

      res.status(201).json({ success: true, data: { invoice } });
    } catch (err) {
      console.error('[Invoices] customer create error:', err);
      res.status(500).json({ success: false, message: 'Invoice creation failed' });
    }
  }
);

/**
 * POST /api/v1/admin/invoices/driver-payout
 * Generate a TDS-applied payout statement for a driver/ride.
 * Body: { rideId?, driverId, grossAmount?, issue? }
 */
router.post(
  '/invoices/driver-payout',
  requirePermission(PERMISSIONS.MANAGE_INVOICES, PERMISSIONS.PROCESS_PAYOUTS),
  auditLog({ action: 'invoice.create_driver_payout', resourceType: 'TaxInvoice' }),
  async (req: Request, res: Response) => {
    try {
      const { rideId, driverId, grossAmount, issue } = req.body || {};
      if (!driverId || !mongoose.isValidObjectId(driverId)) {
        res.status(400).json({ success: false, message: 'Valid driverId required' });
        return;
      }
      const driver = await User.findOne({ _id: driverId, role: 'driver' });
      if (!driver) {
        res.status(404).json({ success: false, message: 'Driver not found' });
        return;
      }

      let ride: any = null;
      let amount = Number(grossAmount || 0);
      if (rideId && mongoose.isValidObjectId(rideId)) {
        ride = await Ride.findById(rideId);
        if (!ride) {
          res.status(404).json({ success: false, message: 'Ride not found' });
          return;
        }
        if (!amount) amount = ride.driverEarnings || 0;
      }
      if (amount <= 0) {
        res.status(400).json({ success: false, message: 'Gross amount must be > 0' });
        return;
      }

      const lines = buildDriverPayoutInvoice({
        driverEarnings: amount,
        rideId: ride?._id?.toString(),
        driverId,
      });

      const invoiceNumber = await generateInvoiceNumber('driver_payout');
      const invoice = await TaxInvoice.create({
        invoiceNumber,
        type: 'driver_payout',
        status: issue ? 'issued' : 'draft',
        driver: driver._id,
        ride: ride?._id,
        ...invoicingDefaults,
        receiverName: `${driver.firstName} ${driver.lastName}`.trim(),
        receiverPan: (driver as any).pan || undefined,
        isInterState: false,
        ...lines,
        issuedAt: issue ? new Date() : undefined,
        createdBy: (req as any).user?._id,
      });

      res.status(201).json({ success: true, data: { invoice } });
    } catch (err) {
      console.error('[Invoices] driver-payout error:', err);
      res.status(500).json({ success: false, message: 'Payout invoice creation failed' });
    }
  }
);

/**
 * POST /api/v1/admin/invoices/:id/issue
 */
router.post(
  '/invoices/:id/issue',
  requirePermission(PERMISSIONS.MANAGE_INVOICES),
  auditLog({ action: 'invoice.issue', resourceType: 'TaxInvoice', resourceId: (req) => req.params.id }),
  async (req: Request, res: Response) => {
    try {
      const inv = await TaxInvoice.findById(req.params.id);
      if (!inv) {
        res.status(404).json({ success: false, message: 'Invoice not found' });
        return;
      }
      if (inv.status !== 'draft') {
        res.status(400).json({ success: false, message: `Cannot issue invoice in status ${inv.status}` });
        return;
      }
      inv.status = 'issued';
      inv.issuedAt = new Date();
      await inv.save();
      res.json({ success: true, data: { invoice: inv } });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Issue failed' });
    }
  }
);

/**
 * POST /api/v1/admin/invoices/:id/cancel
 * Body: { reason }
 */
router.post(
  '/invoices/:id/cancel',
  requirePermission(PERMISSIONS.MANAGE_INVOICES),
  auditLog({ action: 'invoice.cancel', resourceType: 'TaxInvoice', resourceId: (req) => req.params.id }),
  async (req: Request, res: Response) => {
    try {
      const inv = await TaxInvoice.findById(req.params.id);
      if (!inv) {
        res.status(404).json({ success: false, message: 'Invoice not found' });
        return;
      }
      if (inv.status === 'cancelled') {
        res.json({ success: true, data: { invoice: inv } });
        return;
      }
      inv.status = 'cancelled';
      inv.cancelledAt = new Date();
      inv.cancellationReason = req.body?.reason;
      await inv.save();
      res.json({ success: true, data: { invoice: inv } });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Cancel failed' });
    }
  }
);

export default router;
