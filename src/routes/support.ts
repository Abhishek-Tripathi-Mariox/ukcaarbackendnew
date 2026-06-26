import { Router, Response } from 'express';
import mongoose from 'mongoose';
import { SupportTicket, FAQ } from '../models';
import { authenticate, AuthRequest } from '../middleware/auth';
import {
  generateTicketNumber,
  computeSlaDue,
  defaultPriorityForCategory,
} from '../services/ticketing';
import { emitToUser } from '../socket';

const router = Router();
router.use(authenticate);

/**
 * GET /api/v1/support/faqs
 * Active FAQ entries for the caller's app. A driver sees 'driver' + 'both'
 * entries; everyone else (customers) sees 'user' + 'both'. Sorted by the
 * admin-defined `order`. Returns only the fields the apps render.
 */
router.get('/faqs', async (req: AuthRequest, res: Response) => {
  try {
    const audiences =
      req.user?.role === 'driver' ? ['driver', 'both'] : ['user', 'both'];
    const faqs = await FAQ.find({ isActive: true, audience: { $in: audiences } })
      .select('question answer order')
      .sort({ order: 1, createdAt: 1 });
    res.json({ success: true, data: { faqs } });
  } catch (err) {
    console.error('[Support] faqs error:', err);
    res.status(500).json({ success: false, message: 'Failed to load FAQs' });
  }
});

/**
 * Returns a sanitized ticket view for end-users:
 * - hides internal messages
 * - hides admin notes etc.
 */
function sanitizeForUser(ticket: any) {
  if (!ticket) return ticket;
  const obj = typeof ticket.toObject === 'function' ? ticket.toObject() : ticket;
  if (Array.isArray(obj.messages)) {
    obj.messages = obj.messages.filter((m: any) => !m.internal);
  }
  return obj;
}

/**
 * POST /api/v1/support/tickets
 * Customer or driver creates a new ticket.
 */
router.post('/tickets', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    if (user.role !== 'customer' && user.role !== 'driver') {
      return res
        .status(403)
        .json({ success: false, message: 'Only customers and drivers can open tickets' });
    }

    const {
      subject,
      description,
      category = 'other',
      relatedRide,
      relatedPayment,
      attachments,
      tags,
      metadata,
    } = req.body || {};

    if (!subject || !description) {
      return res
        .status(400)
        .json({ success: false, message: 'subject and description are required' });
    }

    const priority = defaultPriorityForCategory(category);
    const ticketNumber = await generateTicketNumber();

    const ticket = await SupportTicket.create({
      ticketNumber,
      subject: String(subject).trim(),
      description: String(description).trim(),
      category,
      priority,
      status: 'open',
      submittedBy: user._id,
      submittedByRole: user.role,
      relatedRide: relatedRide && mongoose.isValidObjectId(relatedRide) ? relatedRide : undefined,
      relatedPayment:
        relatedPayment && mongoose.isValidObjectId(relatedPayment) ? relatedPayment : undefined,
      // Tags let admins filter for special-purpose tickets like
      // 'doc-update' (driver-requested document changes).
      tags: Array.isArray(tags) ? tags.map((t: any) => String(t).trim()).filter(Boolean) : [],
      metadata: metadata && typeof metadata === 'object' ? metadata : undefined,
      slaDueAt: computeSlaDue(priority),
      messages: [
        {
          sender: user._id,
          senderRole: user.role,
          body: String(description).trim(),
          attachments: Array.isArray(attachments) ? attachments : [],
          internal: false,
          createdAt: new Date(),
        },
      ],
    });

    res.status(201).json({ success: true, data: sanitizeForUser(ticket) });
  } catch (err) {
    console.error('[Support] create error:', err);
    res.status(500).json({ success: false, message: 'Failed to create ticket' });
  }
});

/**
 * GET /api/v1/support/tickets
 * Lists tickets owned by the current user.
 */
router.get('/tickets', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const page = Math.max(parseInt(req.query.page as string) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
    const filter: any = { submittedBy: user._id };
    if (req.query.status) filter.status = req.query.status;

    const [items, total] = await Promise.all([
      SupportTicket.find(filter)
        .select('-messages')
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      SupportTicket.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: { items, page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('[Support] list error:', err);
    res.status(500).json({ success: false, message: 'Failed to load tickets' });
  }
});

/**
 * GET /api/v1/support/tickets/:id
 */
router.get('/tickets/:id', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid ticket id' });
    }
    const ticket = await SupportTicket.findOne({ _id: req.params.id, submittedBy: user._id });
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }

    // Mark non-internal admin messages as read by user
    let dirty = false;
    ticket.messages.forEach((m: any) => {
      if (!m.internal && m.senderRole === 'admin' && !m.readByUser) {
        m.readByUser = true;
        dirty = true;
      }
    });
    if (dirty) await ticket.save();

    res.json({ success: true, data: sanitizeForUser(ticket) });
  } catch (err) {
    console.error('[Support] get error:', err);
    res.status(500).json({ success: false, message: 'Failed to load ticket' });
  }
});

/**
 * POST /api/v1/support/tickets/:id/messages
 * User adds a reply.
 */
router.post('/tickets/:id/messages', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid ticket id' });
    }
    const { body, attachments } = req.body || {};
    if (!body || typeof body !== 'string' || !body.trim()) {
      return res.status(400).json({ success: false, message: 'Message body is required' });
    }

    const ticket = await SupportTicket.findOne({ _id: req.params.id, submittedBy: user._id });
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }
    if (ticket.status === 'closed') {
      // A ticket closed by support is terminal — replying can't reopen it.
      // The customer has to start a fresh ticket. Tickets the customer closed
      // themselves stay reopenable, so only block the admin-closed case.
      if (ticket.closedByRole === 'admin') {
        return res.status(409).json({
          success: false,
          code: 'TICKET_CLOSED',
          message:
            'This ticket has been closed by support and can no longer be reopened. Please create a new ticket.',
        });
      }
      ticket.status = 'open';
      ticket.reopenCount = (ticket.reopenCount || 0) + 1;
      ticket.closedAt = undefined;
      ticket.resolvedAt = undefined;
      ticket.closedByRole = undefined;
    } else if (ticket.status === 'pending_user') {
      ticket.status = 'open';
    }

    ticket.messages.push({
      sender: user._id,
      senderRole: user.role as 'customer' | 'driver',
      body: body.trim(),
      attachments: Array.isArray(attachments) ? attachments : [],
      internal: false,
      createdAt: new Date(),
      readByAdmin: false,
      readByUser: true,
    } as any);
    ticket.lastUpdatedBy = user._id;
    await ticket.save();

    if (ticket.assignedTo) {
      emitToUser(ticket.assignedTo.toString(), 'support:message', {
        ticketId: ticket._id.toString(),
        ticketNumber: ticket.ticketNumber,
      });
    }

    res.json({ success: true, data: sanitizeForUser(ticket) });
  } catch (err) {
    console.error('[Support] message error:', err);
    res.status(500).json({ success: false, message: 'Failed to post message' });
  }
});

/**
 * POST /api/v1/support/tickets/:id/close
 * User closes their own ticket.
 */
router.post('/tickets/:id/close', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid ticket id' });
    }
    const ticket = await SupportTicket.findOne({ _id: req.params.id, submittedBy: user._id });
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });
    ticket.status = 'closed';
    ticket.closedAt = new Date();
    // Tag this as a self-close so the customer can still reopen it later by
    // replying — only admin-closed tickets are locked.
    ticket.closedByRole = user.role as 'customer' | 'driver';
    ticket.lastUpdatedBy = user._id;
    await ticket.save();
    res.json({ success: true, data: sanitizeForUser(ticket) });
  } catch (err) {
    console.error('[Support] close error:', err);
    res.status(500).json({ success: false, message: 'Failed to close ticket' });
  }
});

export default router;
