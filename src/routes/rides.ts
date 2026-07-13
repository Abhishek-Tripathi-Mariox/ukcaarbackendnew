import { Router } from 'express';
import {
  estimateFare,
  createRide,
  getRide,
  getRides,
  getActiveRide,
  getAvailableRides,
  acceptRide,
  rejectRide,
  verifyRideOtp,
  updateRideStatus,
  cancelRide,
  rateRide,
  simulateComplete,
} from '../controllers/rideController';
import { authenticate, authorize } from '../middleware/auth';
import { createRideValidation, rateRideValidation } from '../middleware/validators';

const router = Router();

// ── All routes require auth ──
router.use(authenticate);

// ── Customer ──
router.post('/estimate', estimateFare);
router.post('/', createRideValidation, createRide);
router.get('/', getRides);
// /active must be declared before /:id so the literal path wins over the
// param matcher; otherwise express treats "active" as an ObjectId.
router.get('/active', getActiveRide);
// Driver pull-based ride feed — must also precede /:id (literal over param).
router.get('/available', authorize('driver'), getAvailableRides);
router.get('/:id', getRide);
router.put('/:id/cancel', cancelRide);
router.put('/:id/rate', rateRideValidation, rateRide);
router.put('/:id/simulate-complete', simulateComplete); // Demo only

// ── Driver ──
router.put('/:id/accept', authorize('driver'), acceptRide);
router.put('/:id/reject', authorize('driver'), rejectRide);
router.put('/:id/verify-otp', authorize('driver'), verifyRideOtp);
router.put('/:id/status', authorize('driver'), updateRideStatus);

export default router;
