import { Router, Request, Response } from 'express';
import { istDateStr } from '../utils/date';
import { stringify } from 'csv-stringify/sync';
import { Ride, Payment, User, Settlement, TaxInvoice, SupportTicket } from '../models';
import { requirePermission, AuthRequest } from '../middleware/auth';
import { auditLog } from '../middleware/audit';
import { PERMISSIONS } from '../config/permissions';

const router = Router();

// ════════════════════════════════════════════════════════════════════
// HEATMAP — pickup/dropoff density grid
// ════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/admin/heatmap
 *
 * Query: type=pickup|dropoff (default pickup), startDate, endDate, status, rideType
 * Returns: { points: [{ lat, lng, weight }] } aggregated to a coarse grid
 *          to keep the payload bounded.
 */
router.get(
  '/heatmap',
  requirePermission(PERMISSIONS.VIEW_ANALYTICS, PERMISSIONS.VIEW_RIDES),
  async (req: Request, res: Response) => {
    try {
      const type = (req.query.type as string) === 'dropoff' ? 'dropoff' : 'pickup';
      const precision = Math.min(
        Math.max(parseInt(req.query.precision as string) || 3, 2),
        5
      );
      const factor = Math.pow(10, precision);

      const match: any = {};
      if (req.query.startDate || req.query.endDate) {
        match.createdAt = {};
        if (req.query.startDate) match.createdAt.$gte = new Date(req.query.startDate as string);
        if (req.query.endDate) match.createdAt.$lte = new Date(req.query.endDate as string);
      } else {
        // Default: last 30 days
        match.createdAt = { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) };
      }
      if (req.query.status) match.status = req.query.status;
      if (req.query.rideType) match.rideType = req.query.rideType;

      const latField = `$${type}.lat`;
      const lngField = `$${type}.lng`;

      const points = await Ride.aggregate([
        { $match: match },
        {
          $group: {
            _id: {
              lat: {
                $divide: [{ $trunc: { $multiply: [latField, factor] } }, factor],
              },
              lng: {
                $divide: [{ $trunc: { $multiply: [lngField, factor] } }, factor],
              },
            },
            weight: { $sum: 1 },
          },
        },
        { $project: { _id: 0, lat: '$_id.lat', lng: '$_id.lng', weight: 1 } },
        { $sort: { weight: -1 } },
        { $limit: 5000 },
      ]);

      const totalRides = points.reduce((s, p) => s + p.weight, 0);
      const maxWeight = points[0]?.weight ?? 0;

      res.json({
        success: true,
        data: { type, precision, totalRides, maxWeight, points },
      });
    } catch (err) {
      console.error('[Heatmap] error:', err);
      res.status(500).json({ success: false, message: 'Failed to build heatmap' });
    }
  }
);

// ════════════════════════════════════════════════════════════════════
// CSV EXPORTS
// ════════════════════════════════════════════════════════════════════

const ALLOWED_TYPES = [
  'rides',
  'payments',
  'users',
  'drivers',
  'settlements',
  'invoices',
  'tickets',
] as const;
type ExportType = (typeof ALLOWED_TYPES)[number];

const MAX_ROWS = 50_000;

function dateFilter(req: Request) {
  const filter: any = {};
  if (req.query.startDate || req.query.endDate) {
    filter.createdAt = {};
    if (req.query.startDate) filter.createdAt.$gte = new Date(req.query.startDate as string);
    if (req.query.endDate) filter.createdAt.$lte = new Date(req.query.endDate as string);
  }
  return filter;
}

async function fetchRows(type: ExportType, req: Request): Promise<any[]> {
  const filter = dateFilter(req);
  const limit = Math.min(parseInt(req.query.limit as string) || MAX_ROWS, MAX_ROWS);

  switch (type) {
    case 'rides': {
      if (req.query.status) filter.status = req.query.status;
      if (req.query.rideType) filter.rideType = req.query.rideType;
      const items = await Ride.find(filter)
        .populate('customer', 'firstName lastName email phone')
        .populate('driver', 'firstName lastName phone')
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
      return items.map((r: any) => ({
        id: String(r._id),
        createdAt: r.createdAt?.toISOString(),
        status: r.status,
        rideType: r.rideType,
        customerName: `${r.customer?.firstName ?? ''} ${r.customer?.lastName ?? ''}`.trim(),
        customerPhone: r.customer?.phone ?? '',
        driverName: r.driver
          ? `${r.driver.firstName ?? ''} ${r.driver.lastName ?? ''}`.trim()
          : '',
        driverPhone: r.driver?.phone ?? '',
        pickupAddress: r.pickup?.address ?? '',
        pickupLat: r.pickup?.lat,
        pickupLng: r.pickup?.lng,
        dropoffAddress: r.dropoff?.address ?? '',
        dropoffLat: r.dropoff?.lat,
        dropoffLng: r.dropoff?.lng,
        estimatedDistanceKm: r.estimatedDistance,
        actualDistanceKm: r.actualDistance,
        estimatedFare: r.estimatedFare,
        actualFare: r.actualFare,
        commission: r.commission,
        driverEarnings: r.driverEarnings,
        paymentMethod: r.paymentMethod,
        paymentStatus: r.paymentStatus,
        completedAt: r.completedAt?.toISOString() ?? '',
        cancelledAt: r.cancelledAt?.toISOString() ?? '',
        cancellationReason: r.cancellation?.reason ?? '',
      }));
    }

    case 'payments': {
      if (req.query.status) filter.status = req.query.status;
      if (req.query.type) filter.type = req.query.type;
      const items = await Payment.find(filter)
        .populate('user', 'firstName lastName phone email')
        .populate('ride', '_id')
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
      return items.map((p: any) => ({
        id: String(p._id),
        createdAt: p.createdAt?.toISOString(),
        type: p.type,
        status: p.status,
        amount: p.amount,
        currency: p.currency,
        userName: `${p.user?.firstName ?? ''} ${p.user?.lastName ?? ''}`.trim(),
        userPhone: p.user?.phone ?? '',
        rideId: p.ride ? String(p.ride._id ?? p.ride) : '',
        razorpayOrderId: p.razorpayOrderId ?? '',
        razorpayPaymentId: p.razorpayPaymentId ?? '',
      }));
    }

    case 'users': {
      filter.role = 'customer';
      const items = await User.find(filter)
        .select(
          'firstName lastName email phone isActive isVerified createdAt referralCode'
        )
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
      return items.map((u: any) => ({
        id: String(u._id),
        createdAt: u.createdAt?.toISOString(),
        firstName: u.firstName ?? '',
        lastName: u.lastName ?? '',
        email: u.email ?? '',
        phone: u.phone ?? '',
        isActive: u.isActive,
        isVerified: u.isVerified,
        referralCode: u.referralCode ?? '',
      }));
    }

    case 'drivers': {
      filter.role = 'driver';
      const items = await User.find(filter)
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
      return items.map((u: any) => ({
        id: String(u._id),
        createdAt: u.createdAt?.toISOString(),
        firstName: u.firstName ?? '',
        lastName: u.lastName ?? '',
        phone: u.phone ?? '',
        email: u.email ?? '',
        isVerified: u.isVerified,
        isActive: u.isActive,
        totalTrips: u.driverProfile?.totalTrips ?? 0,
        totalEarnings: u.driverProfile?.totalEarnings ?? 0,
        rating: u.driverProfile?.rating ?? 0,
        commission: u.driverProfile?.commission ?? '',
        vehicleNumber: u.driverProfile?.vehicleNumber ?? '',
        vehicleType: u.driverProfile?.vehicleType ?? '',
        isOnline: u.driverProfile?.isOnline ?? false,
      }));
    }

    case 'settlements': {
      if (req.query.status) filter.status = req.query.status;
      const items = await Settlement.find(filter)
        .populate('payment', 'amount')
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
      return items.map((s: any) => ({
        id: String(s._id),
        createdAt: s.createdAt?.toISOString(),
        razorpaySettlementId: s.razorpaySettlementId,
        razorpayPaymentId: s.razorpayPaymentId ?? '',
        utr: s.utr ?? '',
        grossAmount: s.grossAmount,
        fee: s.fee,
        tax: s.tax,
        netAmount: s.netAmount,
        currency: s.currency,
        status: s.status,
        diff: s.diff ?? '',
        expectedAmount: s.expectedAmount ?? '',
        mismatchReason: s.mismatchReason ?? '',
        batchId: s.batchId ?? '',
        settledAt: s.settledAt?.toISOString() ?? '',
      }));
    }

    case 'invoices': {
      if (req.query.type) filter.type = req.query.type;
      if (req.query.status) filter.status = req.query.status;
      const items = await TaxInvoice.find(filter)
        .populate('customer', 'firstName lastName')
        .populate('driver', 'firstName lastName')
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
      return items.map((i: any) => ({
        id: String(i._id),
        invoiceNumber: i.invoiceNumber,
        type: i.type,
        status: i.status,
        createdAt: i.createdAt?.toISOString(),
        issuedAt: i.issuedAt?.toISOString() ?? '',
        partyName:
          i.receiverName ||
          (i.customer
            ? `${i.customer.firstName ?? ''} ${i.customer.lastName ?? ''}`.trim()
            : i.driver
            ? `${i.driver.firstName ?? ''} ${i.driver.lastName ?? ''}`.trim()
            : ''),
        subTotal: i.subTotal,
        totalCgst: i.totalCgst,
        totalSgst: i.totalSgst,
        totalIgst: i.totalIgst,
        totalTax: i.totalTax,
        totalAmount: i.totalAmount,
        tdsApplicable: i.tdsApplicable,
        tdsAmount: i.tdsAmount ?? '',
        netPayable: i.netPayable ?? '',
      }));
    }

    case 'tickets': {
      if (req.query.status) filter.status = req.query.status;
      if (req.query.priority) filter.priority = req.query.priority;
      const items = await SupportTicket.find(filter)
        .select('-messages')
        .populate('submittedBy', 'firstName lastName phone role')
        .populate('assignedTo', 'firstName lastName')
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
      return items.map((t: any) => ({
        id: String(t._id),
        ticketNumber: t.ticketNumber,
        createdAt: t.createdAt?.toISOString(),
        subject: t.subject,
        category: t.category,
        priority: t.priority,
        status: t.status,
        submittedByRole: t.submittedByRole,
        submittedBy: `${t.submittedBy?.firstName ?? ''} ${t.submittedBy?.lastName ?? ''}`.trim(),
        submittedByPhone: t.submittedBy?.phone ?? '',
        assignedTo: t.assignedTo
          ? `${t.assignedTo.firstName ?? ''} ${t.assignedTo.lastName ?? ''}`.trim()
          : '',
        slaDueAt: t.slaDueAt?.toISOString() ?? '',
        firstResponseAt: t.firstResponseAt?.toISOString() ?? '',
        resolvedAt: t.resolvedAt?.toISOString() ?? '',
        closedAt: t.closedAt?.toISOString() ?? '',
        reopenCount: t.reopenCount ?? 0,
      }));
    }
  }
}

/**
 * GET /api/v1/admin/exports/:type.csv
 * Streams a CSV of the requested resource type.
 */
router.get(
  '/exports/:type',
  requirePermission(PERMISSIONS.EXPORT_REPORTS),
  auditLog({
    action: 'admin.export',
    resourceType: 'export',
    resourceId: (req: AuthRequest) => req.params.type,
  }),
  async (req: Request, res: Response) => {
    try {
      const raw = String(req.params.type || '').replace(/\.csv$/i, '');
      if (!ALLOWED_TYPES.includes(raw as ExportType)) {
        return res
          .status(400)
          .json({ success: false, message: `Unknown export type. Allowed: ${ALLOWED_TYPES.join(', ')}` });
      }
      const type = raw as ExportType;
      const rows = await fetchRows(type, req);
      const csv = stringify(rows, { header: true });
      const ts = istDateStr();
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="ukcaar-${type}-${ts}.csv"`
      );
      res.send(csv);
    } catch (err) {
      console.error('[Export] error:', err);
      res.status(500).json({ success: false, message: 'Export failed' });
    }
  }
);

/**
 * GET /api/v1/admin/exports
 * Lists allowed export types (used by admin UI).
 */
router.get(
  '/exports',
  requirePermission(PERMISSIONS.EXPORT_REPORTS),
  (_req: Request, res: Response) => {
    res.json({ success: true, data: { types: ALLOWED_TYPES, maxRows: MAX_ROWS } });
  }
);

export default router;
