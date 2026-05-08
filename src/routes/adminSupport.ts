import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { SupportTicket, User } from '../models';
import { AuthRequest, requirePermission } from '../middleware/auth';
import { auditLog } from '../middleware/audit';
import { PERMISSIONS } from '../config/permissions';
import { computeSlaDue } from '../services/ticketing';
import { emitToUser } from '../socket';

const router = Router();

// ════════════════════════════════════════════════════════════════════
// SUPPORT TICKETS (admin)
// ════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/admin/tickets
 * Paginated list of all tickets, with filters.
 */
router.get(
  '/tickets',
  requirePermission(PERMISSIONS.VIEW_TICKETS, PERMISSIONS.VIEW_CHATS),
  async (req: Request, res: Response) => {
    try {
      const page = Math.max(parseInt(req.query.page as string) || 1, 1);
      const limit = Math.min(parseInt(req.query.limit as string) || 25, 100);
      const filter: any = {};

      if (req.query.status) filter.status = req.query.status;
      if (req.query.priority) filter.priority = req.query.priority;
      if (req.query.category) filter.category = req.query.category;
      if (req.query.assignedTo) {
        filter.assignedTo =
          req.query.assignedTo === 'unassigned' ? { $exists: false } : req.query.assignedTo;
      }
      if (req.query.submittedByRole) filter.submittedByRole = req.query.submittedByRole;
      if (req.query.q) {
        const q = String(req.query.q).trim();
        if (q.startsWith('TKT-')) filter.ticketNumber = q;
        else filter.$or = [
          { subject: { $regex: q, $options: 'i' } },
          { ticketNumber: { $regex: q, $options: 'i' } },
        ];
      }
      if (req.query.startDate || req.query.endDate) {
        filter.createdAt = {};
        if (req.query.startDate) filter.createdAt.$gte = new Date(req.query.startDate as string);
        if (req.query.endDate) filter.createdAt.$lte = new Date(req.query.endDate as string);
      }

      const [items, total, summary] = await Promise.all([
        SupportTicket.find(filter)
          .select('-messages')
          .populate('submittedBy', 'firstName lastName email phone role')
          .populate('assignedTo', 'firstName lastName email')
          .sort({ priority: -1, createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit),
        SupportTicket.countDocuments(filter),
        SupportTicket.aggregate([
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ]),
      ]);

      const statusCounts: Record<string, number> = {};
      summary.forEach((row) => {
        statusCounts[row._id] = row.count;
      });

      res.json({
        success: true,
        data: {
          items,
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
          statusCounts,
        },
      });
    } catch (err) {
      console.error('[AdminSupport] list error:', err);
      res.status(500).json({ success: false, message: 'Failed to load tickets' });
    }
  }
);

/**
 * GET /api/v1/admin/tickets/:id
 */
router.get(
  '/tickets/:id',
  requirePermission(PERMISSIONS.VIEW_TICKETS, PERMISSIONS.VIEW_CHATS),
  async (req: Request, res: Response) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ success: false, message: 'Invalid ticket id' });
      }
      const ticket = await SupportTicket.findById(req.params.id)
        .populate('submittedBy', 'firstName lastName email phone role')
        .populate('assignedTo', 'firstName lastName email adminRole')
        .populate('relatedRide', '_id status pickup dropoff actualFare estimatedFare')
        .populate('relatedPayment', '_id amount status type')
        .populate('messages.sender', 'firstName lastName email role adminRole');
      if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });

      // Mark customer/driver messages as read by admin.
      let dirty = false;
      ticket.messages.forEach((m: any) => {
        if (m.senderRole !== 'admin' && !m.readByAdmin) {
          m.readByAdmin = true;
          dirty = true;
        }
      });
      if (dirty) await ticket.save();

      res.json({ success: true, data: ticket });
    } catch (err) {
      console.error('[AdminSupport] get error:', err);
      res.status(500).json({ success: false, message: 'Failed to load ticket' });
    }
  }
);

/**
 * PATCH /api/v1/admin/tickets/:id
 * Update status / priority / assignedTo / tags / resolution.
 */
router.patch(
  '/tickets/:id',
  requirePermission(PERMISSIONS.MANAGE_TICKETS),
  auditLog({
    action: 'support.ticket.update',
    resourceType: 'support_ticket',
    resourceId: (req) => req.params.id,
  }),
  async (req: AuthRequest, res: Response) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ success: false, message: 'Invalid ticket id' });
      }
      const ticket = await SupportTicket.findById(req.params.id);
      if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });

      const { status, priority, assignedTo, tags, resolution } = req.body || {};
      let priorityChanged = false;

      if (priority && priority !== ticket.priority) {
        ticket.priority = priority;
        ticket.slaDueAt = computeSlaDue(priority, new Date());
        priorityChanged = true;
      }

      if (status && status !== ticket.status) {
        ticket.status = status;
        if (status === 'resolved') ticket.resolvedAt = new Date();
        if (status === 'closed') ticket.closedAt = new Date();
        if (status === 'open' && (ticket.closedAt || ticket.resolvedAt)) {
          ticket.reopenCount = (ticket.reopenCount || 0) + 1;
          ticket.closedAt = undefined;
          ticket.resolvedAt = undefined;
        }
      }

      if (assignedTo !== undefined) {
        if (assignedTo === null || assignedTo === '') {
          ticket.assignedTo = undefined;
        } else if (mongoose.isValidObjectId(assignedTo)) {
          ticket.assignedTo = new mongoose.Types.ObjectId(assignedTo);
        }
      }
      if (Array.isArray(tags)) ticket.tags = tags.map((t) => String(t).trim()).filter(Boolean);
      if (typeof resolution === 'string') ticket.resolution = resolution;
      ticket.lastUpdatedBy = (req as any).user?._id;
      await ticket.save();

      if (priorityChanged && ticket.assignedTo) {
        emitToUser(ticket.assignedTo.toString(), 'support:priority', {
          ticketId: ticket._id.toString(),
          priority: ticket.priority,
        });
      }

      res.json({ success: true, data: ticket });
    } catch (err) {
      console.error('[AdminSupport] update error:', err);
      res.status(500).json({ success: false, message: 'Failed to update ticket' });
    }
  }
);

/**
 * POST /api/v1/admin/tickets/:id/assign
 * Assign / claim ticket (separate from PATCH so it can be permission-gated differently).
 */
router.post(
  '/tickets/:id/assign',
  requirePermission(PERMISSIONS.ASSIGN_TICKETS, PERMISSIONS.MANAGE_TICKETS),
  auditLog({
    action: 'support.ticket.assign',
    resourceType: 'support_ticket',
    resourceId: (req) => req.params.id,
  }),
  async (req: AuthRequest, res: Response) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ success: false, message: 'Invalid ticket id' });
      }
      const ticket = await SupportTicket.findById(req.params.id);
      if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });

      const { adminId, claim } = req.body || {};
      let target: mongoose.Types.ObjectId | undefined;
      if (claim) {
        target = (req as any).user?._id;
      } else if (adminId === null || adminId === '') {
        ticket.assignedTo = undefined;
      } else if (adminId && mongoose.isValidObjectId(adminId)) {
        const admin = await User.findOne({ _id: adminId, role: 'admin' });
        if (!admin) return res.status(404).json({ success: false, message: 'Admin not found' });
        target = admin._id;
      }
      if (target) ticket.assignedTo = target;
      if (ticket.status === 'open') ticket.status = 'in_progress';
      ticket.lastUpdatedBy = (req as any).user?._id;
      await ticket.save();

      if (ticket.assignedTo) {
        emitToUser(ticket.assignedTo.toString(), 'support:assigned', {
          ticketId: ticket._id.toString(),
          ticketNumber: ticket.ticketNumber,
        });
      }

      res.json({ success: true, data: ticket });
    } catch (err) {
      console.error('[AdminSupport] assign error:', err);
      res.status(500).json({ success: false, message: 'Failed to assign ticket' });
    }
  }
);

/**
 * POST /api/v1/admin/tickets/:id/messages
 * Admin posts a reply (or internal note when internal=true).
 */
router.post(
  '/tickets/:id/messages',
  requirePermission(PERMISSIONS.MANAGE_TICKETS),
  auditLog({
    action: 'support.ticket.reply',
    resourceType: 'support_ticket',
    resourceId: (req) => req.params.id,
  }),
  async (req: AuthRequest, res: Response) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ success: false, message: 'Invalid ticket id' });
      }
      const { body, attachments, internal } = req.body || {};
      if (!body || typeof body !== 'string' || !body.trim()) {
        return res.status(400).json({ success: false, message: 'Message body is required' });
      }
      const ticket = await SupportTicket.findById(req.params.id);
      if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });

      const adminId = (req as any).user?._id;
      const isInternal = !!internal;

      ticket.messages.push({
        sender: adminId,
        senderRole: 'admin',
        body: body.trim(),
        attachments: Array.isArray(attachments) ? attachments : [],
        internal: isInternal,
        createdAt: new Date(),
        readByAdmin: true,
        readByUser: false,
      } as any);

      if (!isInternal) {
        if (!ticket.firstResponseAt) ticket.firstResponseAt = new Date();
        if (ticket.status === 'open') ticket.status = 'in_progress';
        // Notify the original requester
        emitToUser(ticket.submittedBy.toString(), 'support:message', {
          ticketId: ticket._id.toString(),
          ticketNumber: ticket.ticketNumber,
        });
      }
      ticket.lastUpdatedBy = adminId;
      await ticket.save();

      res.json({ success: true, data: ticket });
    } catch (err) {
      console.error('[AdminSupport] reply error:', err);
      res.status(500).json({ success: false, message: 'Failed to post reply' });
    }
  }
);

/**
 * GET /api/v1/admin/tickets-stats
 * Dashboard summary numbers (open, breached SLA, by priority).
 */
router.get(
  '/tickets-stats',
  requirePermission(PERMISSIONS.VIEW_TICKETS, PERMISSIONS.VIEW_CHATS),
  async (_req: Request, res: Response) => {
    try {
      const now = new Date();
      const [byStatus, byPriority, breached, unassignedOpen] = await Promise.all([
        SupportTicket.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
        SupportTicket.aggregate([
          { $match: { status: { $in: ['open', 'in_progress', 'pending_user'] } } },
          { $group: { _id: '$priority', count: { $sum: 1 } } },
        ]),
        SupportTicket.countDocuments({
          status: { $in: ['open', 'in_progress'] },
          slaDueAt: { $lt: now },
        }),
        SupportTicket.countDocuments({
          status: { $in: ['open', 'in_progress'] },
          assignedTo: { $exists: false },
        }),
      ]);

      const status: Record<string, number> = {};
      byStatus.forEach((r) => (status[r._id] = r.count));
      const priority: Record<string, number> = {};
      byPriority.forEach((r) => (priority[r._id] = r.count));

      res.json({
        success: true,
        data: { status, priority, breachedSla: breached, unassignedOpen },
      });
    } catch (err) {
      console.error('[AdminSupport] stats error:', err);
      res.status(500).json({ success: false, message: 'Failed to load stats' });
    }
  }
);

export default router;
