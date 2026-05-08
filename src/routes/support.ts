import { Router, Response } from 'express';
import mongoose from 'mongoose';
import { SupportTicket } from '../models';
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
      ticket.status = 'open';
      ticket.reopenCount = (ticket.reopenCount || 0) + 1;
      ticket.closedAt = undefined;
      ticket.resolvedAt = undefined;
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
    ticket.lastUpdatedBy = user._id;
    await ticket.save();
    res.json({ success: true, data: sanitizeForUser(ticket) });
  } catch (err) {
    console.error('[Support] close error:', err);
    res.status(500).json({ success: false, message: 'Failed to close ticket' });
  }
});

export default router;
