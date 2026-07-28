import { Router } from 'express';
import authRoutes from './auth';
import rideRoutes from './rides';
import paymentRoutes from './payments';
import driverRoutes from './driver';
import driverJourneyRoutes from './driverJourneys';
import chatRoutes from './chat';
import adminRoutes from './admin';
import uploadRoutes from './uploads';
import notificationRoutes from './notifications';
import supportRoutes from './support';
import loyaltyRoutes from './loyalty';
import geoRoutes from './geo';
import vehicleTypeRoutes from './vehicleTypes';
import routeRoutes from './routes';
import safetyRoutes from './safety';
import appSettingsRoutes from './appSettings';

const router = Router();

// ── Maintenance mode enforcement ──
// The admin Settings toggle promised "disable app access for users during
// maintenance" but nothing ever checked the flag. Blocks app traffic with 503
// while exempting: auth (so admins can log in), /admin (the panel itself),
// /settings (apps poll it to show their own maintenance notice) and /health.
// The flag is re-read at most every 30s so toggling applies quickly without a
// DB hit per request.
let maintCache = { value: false, at: 0 };
router.use(async (req, res, next) => {
  const path = req.path;
  if (
    path.startsWith('/auth') ||
    path.startsWith('/admin') ||
    path.startsWith('/settings') ||
    path.startsWith('/health')
  ) {
    return next();
  }
  try {
    if (Date.now() - maintCache.at > 30_000) {
      const { Settings } = await import('../models');
      const doc: any = await Settings.findOne({ key: 'platform' })
        .select('maintenanceMode')
        .lean();
      maintCache = { value: !!doc?.maintenanceMode, at: Date.now() };
    }
  } catch {
    // On a settings read failure, fail OPEN — never lock the whole API out
    // because of a transient DB hiccup.
    maintCache = { value: false, at: Date.now() };
  }
  if (maintCache.value) {
    res.status(503).json({
      success: false,
      maintenance: true,
      message: 'UKCAAR is temporarily down for maintenance. Please try again shortly.',
    });
    return;
  }
  next();
});

router.use('/auth', authRoutes);
router.use('/rides', rideRoutes);
router.use('/payments', paymentRoutes);
// More-specific prefix must register before '/drivers' so it wins the match.
router.use('/drivers/journeys', driverJourneyRoutes);
router.use('/drivers', driverRoutes);
router.use('/chat', chatRoutes);
router.use('/admin', adminRoutes);
router.use('/uploads', uploadRoutes);
router.use('/notifications', notificationRoutes);
router.use('/support', supportRoutes);
router.use('/loyalty', loyaltyRoutes);
router.use('/geo', geoRoutes);
router.use('/routes', routeRoutes);
router.use('/safety', safetyRoutes);
// Public read-only settings the rider app needs (support contacts, referral
// bonus, safety links) — see appSettings.ts.
router.use('/settings', appSettingsRoutes);
router.use('/', vehicleTypeRoutes);

// Health check
router.get('/health', (_req, res) => {
  res.status(200).json({
    success: true,
    message: 'UKCAAR API is running',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  });
});

export default router;
