import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { User, SupportTicket } from '../models';
import {
  generateTicketNumber,
  computeSlaDue,
  defaultPriorityForCategory,
} from '../services/ticketing';
import { emitToRide } from '../socket';

const router = Router();
router.use(authenticate);

const MAX_CONTACTS = 5;

/** GET /api/v1/safety/contacts — the user's saved emergency contacts. */
router.get('/contacts', async (req: AuthRequest, res: Response) => {
  try {
    const user = await User.findById(req.user!._id).select('emergencyContacts');
    res.json({ success: true, data: { contacts: user?.emergencyContacts ?? [] } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to load contacts' });
  }
});

/**
 * PUT /api/v1/safety/contacts — replace the whole list.
 * Body: { contacts: [{ name, phone }] }
 */
router.put('/contacts', async (req: AuthRequest, res: Response) => {
  try {
    const incoming = Array.isArray(req.body?.contacts) ? req.body.contacts : [];
    const contacts = incoming
      .map((c: any) => ({
        name: String(c?.name ?? '').trim(),
        phone: String(c?.phone ?? '').trim(),
      }))
      .filter((c: any) => c.name && c.phone)
      .slice(0, MAX_CONTACTS);

    const user = await User.findByIdAndUpdate(
      req.user!._id,
      { emergencyContacts: contacts },
      { new: true },
    ).select('emergencyContacts');

    res.json({ success: true, data: { contacts: user?.emergencyContacts ?? [] } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to save contacts' });
  }
});

/**
 * POST /api/v1/safety/sos — raise an emergency alert.
 * Body: { lat?, lng?, rideId? }
 *
 * Admin alerting reuses the support-ticket pipeline: we open an `urgent`
 * 'safety'-category ticket so it lands at the top of the Support console with
 * the user's live location + emergency contacts attached. If the SOS happens
 * during a ride we also push a socket event on the ride room so ops watching
 * the live map see it immediately.
 */
router.post('/sos', async (req: AuthRequest, res: Response) => {
  try {
    const { lat, lng, rideId } = req.body || {};
    const user = await User.findById(req.user!._id).select(
      'firstName lastName phone emergencyContacts',
    );
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    const hasLoc = typeof lat === 'number' && typeof lng === 'number';
    const mapLink = hasLoc ? `https://maps.google.com/?q=${lat},${lng}` : 'Location unavailable';
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Customer';

    const priority = defaultPriorityForCategory('safety');
    const ticketNumber = await generateTicketNumber();
    const description = [
      `🚨 SOS triggered by ${name} (${user.phone}).`,
      `Live location: ${mapLink}`,
      `Emergency contacts: ${
        (user.emergencyContacts ?? []).map((c) => `${c.name} (${c.phone})`).join(', ') || 'none saved'
      }`,
    ].join('\n');

    const ticket = await SupportTicket.create({
      ticketNumber,
      subject: `🚨 SOS — ${name}`,
      description,
      category: 'safety',
      priority,
      status: 'open',
      submittedBy: user._id,
      submittedByRole: req.user!.role,
      tags: ['sos'],
      metadata: { lat, lng, rideId: rideId ?? null, mapLink },
      slaDueAt: computeSlaDue(priority),
      messages: [
        {
          sender: user._id,
          senderRole: req.user!.role,
          body: description,
          attachments: [],
          internal: false,
          createdAt: new Date(),
        },
      ],
    });

    // Live nudge to anyone watching the ride room (driver + ops dashboards).
    if (rideId) {
      emitToRide(String(rideId), 'safety:sos', {
        userId: String(user._id),
        name,
        phone: user.phone,
        lat,
        lng,
        ticketNumber,
      });
    }

    res.status(201).json({
      success: true,
      data: {
        ticketNumber: ticket.ticketNumber,
        notifiedContacts: (user.emergencyContacts ?? []).length,
      },
    });
  } catch (err) {
    console.error('[Safety] sos error:', err);
    res.status(500).json({ success: false, message: 'Failed to raise SOS' });
  }
});

export default router;
