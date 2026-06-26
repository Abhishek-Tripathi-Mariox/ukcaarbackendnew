import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import {
  listScheduledRoutes,
  getRouteById,
  registerDriverForRoute,
  getMyRouteRegistration,
  getRouteVehicles,
  getRouteSeats,
  bookRouteSeats,
  cancelRouteBooking,
} from '../controllers/routeController';

/**
 * Driver and customer-facing route endpoints. The admin keeps its own full
 * CRUD at /admin/routes — this file is for read-only browsing + driver
 * self-registration.
 */
const router = Router();

router.use(authenticate);

router.get('/scheduled', listScheduledRoutes);
router.get('/my-registration', authorize('driver'), getMyRouteRegistration);
router.post('/bookings/:bookingId/cancel', cancelRouteBooking);
router.get('/:id', getRouteById);
router.get('/:id/vehicles', getRouteVehicles);
router.get('/:id/seats', getRouteSeats);
router.post('/:id/book', bookRouteSeats);
router.post('/:id/register', authorize('driver'), registerDriverForRoute);

export default router;
