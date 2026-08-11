import { Response } from 'express';
import { isValidObjectId } from 'mongoose';
import { Chat, Ride, ScheduledBooking } from '../models';
import { AuthRequest } from '../middleware/auth';

/**
 * The two chat participants for a ride-or-booking id. Instant rides key chat
 * by the Ride _id; scheduled shuttles have no Ride doc, so their chat is
 * keyed by the ScheduledBooking _id instead. Returns null if neither exists.
 */
async function chatParticipants(
  chatId: string,
): Promise<{ customer?: any; driver?: any } | null> {
  if (!isValidObjectId(chatId)) return null;
  const ride = await Ride.findById(chatId).select('customer driver');
  if (ride) return { customer: ride.customer, driver: ride.driver };
  const booking = await ScheduledBooking.findById(chatId).select('customer driver');
  if (booking) return { customer: booking.customer, driver: booking.driver };
  return null;
}

/**
 * Returns true if the authenticated user is the customer or assigned driver
 * of the given ride/booking. Admins are allowed through (they use the admin
 * chat viewer). Returns false if neither a ride nor a booking exists.
 */
async function isRideParticipant(req: AuthRequest, rideId: string): Promise<boolean> {
  if (req.user?.role === 'admin') return true;
  const parties = await chatParticipants(rideId);
  if (!parties) return false;
  const uid = req.user!._id.toString();
  return (
    parties.customer?.toString() === uid ||
    (!!parties.driver && parties.driver.toString() === uid)
  );
}

/**
 * GET /api/v1/chat/:rideId
 */
export const getChat = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    // Only the ride's participants may read its chat.
    if (!(await isRideParticipant(req, req.params.rideId))) {
      res.status(403).json({ success: false, message: 'Not authorized to view this chat' });
      return;
    }

    let chat = await Chat.findOne({ ride: req.params.rideId })
      .populate('messages.sender', 'firstName lastName avatar');

    if (!chat) {
      res.status(200).json({ success: true, data: { chat: null, messages: [] } });
      return;
    }

    res.status(200).json({
      success: true,
      data: { chat },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch chat' });
  }
};

/**
 * POST /api/v1/chat/:rideId/message
 */
export const sendMessage = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { content, type = 'text' } = req.body;
    if (!content) {
      res.status(400).json({ success: false, message: 'Message content required' });
      return;
    }

    // Only the ride's participants may post into its chat.
    if (!(await isRideParticipant(req, req.params.rideId))) {
      res.status(403).json({ success: false, message: 'Not authorized to message in this chat' });
      return;
    }

    let chat = await Chat.findOne({ ride: req.params.rideId });
    if (!chat) {
      const parties = await chatParticipants(req.params.rideId);
      if (!parties) {
        res.status(404).json({ success: false, message: 'Ride not found' });
        return;
      }
      chat = await Chat.create({
        ride: req.params.rideId,
        participants: [parties.customer, parties.driver].filter(Boolean),
        messages: [],
      });
    }

    const message = {
      sender: req.user!._id,
      content,
      type,
      read: false,
      createdAt: new Date(),
    };

    chat.messages.push(message);
    await chat.save();

    // In production: io.to(`ride:${req.params.rideId}`).emit('new_message', message);

    res.status(201).json({
      success: true,
      data: { message: chat.messages[chat.messages.length - 1] },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to send message' });
  }
};
