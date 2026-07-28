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

    // A single FCM token represents one physical device, and FCM
    // delivers each push to ONE recipient per token. If driver A logged
    // out on this phone and driver B logged in, the token would still be
    // sitting in driver A's `fcmTokens` array — so pushes aimed at A
    // would ring on B's phone.
    //
    // Fix: globally pull this token off any OTHER user before pushing it
    // onto the current user. Multi-device for the same user is preserved
    // (we only remove the token from *other* users; the current user's
    // record gets it $push-ed below). Cheap — matched-set is tiny
    // (only the previous owner, if any).
    await User.updateMany(
      { 'fcmTokens.token': token, _id: { $ne: req.user!._id } },
      { $pull: { fcmTokens: { token } } },
    );

    // Same dedupe inside the current user's record (re-registration path).
    await User.updateOne(
      { _id: req.user!._id },
      { $pull: { fcmTokens: { token } } },
    );
    await User.updateOne(
      { _id: req.user!._id },
      { $push: { fcmTokens: { token, platform, updatedAt: new Date() } } },
    );

    console.log(
      `[fcm] registered token for user=${req.user!._id} platform=${platform} ` +
      `token=...${token.slice(-8)}`,
    );

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('[fcm] registerFcmToken error:', error);
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
  const user = await User.findById(userId).select('fcmTokens isActive deletedAt');
  if (!user || user.fcmTokens.length === 0) {
    console.log(
      `[fcm] sendPushToUser user=${userId} skipped: ` +
        (!user ? 'user not found' : 'no fcmTokens registered'),
    );
    return;
  }

  // Safety net for tokens that outlive the account: a disabled/self-deleted
  // user must never get pushes, even if a stale token is still on the record
  // (e.g. logout ran offline and the unregister call never reached us).
  if (!user.isActive || user.deletedAt) {
    console.log(
      `[fcm] sendPushToUser user=${userId} skipped: ` +
        (user.deletedAt ? 'account deleted' : 'account inactive'),
    );
    return;
  }

  const tokens = user.fcmTokens.map((t) => t.token);
  const kind = payload.data?.kind ?? 'generic';
  const { successCount, invalidTokens } = await sendPushToTokens(tokens, payload);
  console.log(
    `[fcm] sendPushToUser user=${userId} kind=${kind} ` +
      `tokens=${tokens.length} success=${successCount} invalid=${invalidTokens.length}`,
  );

  if (invalidTokens.length > 0) {
    await User.updateOne(
      { _id: userId },
      { $pull: { fcmTokens: { token: { $in: invalidTokens } } } },
    );
  }
}
