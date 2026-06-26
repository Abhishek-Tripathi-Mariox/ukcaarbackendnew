import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import {
  listVehicleTypesPublic,
  listNearbyVehicleTypes,
  listFuelTypesPublic,
} from '../controllers/vehicleTypeController';

const router = Router();
router.use(authenticate);

// Driver app uses these to populate dropdowns on the vehicle-details form.
router.get('/vehicle-types', listVehicleTypesPublic);
// Customer app uses this — only returns types with available drivers near
// the pickup, grouped by tier for the Instant / Private tabs.
router.get('/vehicle-types/nearby', listNearbyVehicleTypes);
router.get('/fuel-types', listFuelTypesPublic);

export default router;
