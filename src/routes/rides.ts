import { Router } from 'express';
import {
  estimateFare,
  createRide,
  getRide,
  getRides,
  acceptRide,
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
router.get('/:id', getRide);
router.put('/:id/cancel', cancelRide);
router.put('/:id/rate', rateRideValidation, rateRide);
router.put('/:id/simulate-complete', simulateComplete); // Demo only

// ── Driver ──
router.put('/:id/accept', authorize('driver'), acceptRide);
router.put('/:id/status', authorize('driver'), updateRideStatus);

export default router;
