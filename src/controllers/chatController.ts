import { Response } from 'express';
import { Chat } from '../models';
import { AuthRequest } from '../middleware/auth';

/**
 * GET /api/v1/chat/:rideId
 */
export const getChat = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
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

    let chat = await Chat.findOne({ ride: req.params.rideId });
    if (!chat) {
      const { Ride } = await import('../models/Ride');
      const ride = await Ride.findById(req.params.rideId);
      if (!ride) {
        res.status(404).json({ success: false, message: 'Ride not found' });
        return;
      }
      chat = await Chat.create({
        ride: ride._id,
        participants: [ride.customer, ride.driver].filter(Boolean),
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
