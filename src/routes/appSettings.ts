import { Router, Request, Response } from 'express';
import { Settings } from '../models';

const router = Router();

/**
 * Public, read-only slice of the platform settings the RIDER APP needs.
 *
 * The admin panel already owned support contacts, the referral bonus and the
 * safety links, but nothing exposed them outside /admin — so the apps had them
 * hardcoded and drifted (the Account row promised "₹10", Refer & Earn promised
 * "₹400", and the support number was the literal placeholder +911800XXXXXXX).
 * This endpoint is the single source of truth for all of them.
 *
 * Deliberately unauthenticated: it carries no user data, and the Safety screen
 * needs the helpline even when a token has expired.
 */
router.get('/app', async (_req: Request, res: Response) => {
  try {
    const doc = await Settings.findOne({ key: 'platform' })
      .select(
        'appName supportEmail supportPhone referralBonus referrerRewardCustomer referrerRewardDriver ' +
          'safetyHelpline safetyGuidelinesUrl maintenanceMode',
      )
      .lean();

    res.status(200).json({
      success: true,
      data: {
        appName: doc?.appName || 'UKCAAR',
        supportEmail: doc?.supportEmail || '',
        supportPhone: doc?.supportPhone || '',
        referralBonus: Number(doc?.referralBonus ?? 0),
        // What the REFERRER earns once someone they referred completes a
        // first ride — this is the number Refer & Earn should advertise.
        referrerRewardCustomer: Number(doc?.referrerRewardCustomer ?? 0),
        referrerRewardDriver: Number(doc?.referrerRewardDriver ?? 0),
        safetyHelpline: doc?.safetyHelpline || '',
        safetyGuidelinesUrl: doc?.safetyGuidelinesUrl || '',
        maintenanceMode: !!doc?.maintenanceMode,
        currencySymbol: '₹',
      },
    });
  } catch (error) {
    console.error('GET /settings/app error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch app settings' });
  }
});

export default router;
