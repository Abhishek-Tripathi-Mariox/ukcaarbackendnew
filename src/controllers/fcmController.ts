import { Response } from 'express';
import { User } from '../models';
import { AuthRequest } from '../middleware/auth';
import { sendPushToTokens, PushPayload } from '../config/firebase';

/**
 * POST /api/v1/notifications/fcm-token
 * Body: { token: string, platform: 'ios' | 'android' }
 * Registers (or refreshes) a device's FCM token for the authenticated user.
 */
export const registerFcmToken = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { token, platform } = req.body as { token?: string; platform?: 'ios' | 'android' };
    if (!token || !platform || !['ios', 'android'].includes(platform)) {
      res.status(400).json({ success: false, message: 'token and platform are required' });
      return;
    }

    await User.updateOne(
      { _id: req.user!._id },
      { $pull: { fcmTokens: { token } } },
    );
    await User.updateOne(
      { _id: req.user!._id },
      { $push: { fcmTokens: { token, platform, updatedAt: new Date() } } },
    );

    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to register FCM token' });
  }
};

/**
 * DELETE /api/v1/notifications/fcm-token
 * Body: { token: string }
 * Removes the given token from the authenticated user (call on logout / app uninstall flow).
 */
export const unregisterFcmToken = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { token } = req.body as { token?: string };
    if (!token) {
      res.status(400).json({ success: false, message: 'token is required' });
      return;
    }
    await User.updateOne(
      { _id: req.user!._id },
      { $pull: { fcmTokens: { token } } },
    );
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to unregister FCM token' });
  }
};

/**
 * Internal helper used by other controllers (rides, payments, chat).
 * Sends a push to all of a user's registered devices and prunes invalid tokens.
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  const user = await User.findById(userId).select('fcmTokens');
  if (!user || user.fcmTokens.length === 0) return;

  const tokens = user.fcmTokens.map((t) => t.token);
  const { invalidTokens } = await sendPushToTokens(tokens, payload);

  if (invalidTokens.length > 0) {
    await User.updateOne(
      { _id: userId },
      { $pull: { fcmTokens: { token: { $in: invalidTokens } } } },
    );
  }
}
