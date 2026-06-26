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

const router = Router();

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
