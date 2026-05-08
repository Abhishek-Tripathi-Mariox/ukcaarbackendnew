import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import {
  listVehicleTypesPublic,
  listFuelTypesPublic,
} from '../controllers/vehicleTypeController';

const router = Router();
router.use(authenticate);

// Driver app uses these to populate dropdowns on the vehicle-details form.
router.get('/vehicle-types', listVehicleTypesPublic);
router.get('/fuel-types', listFuelTypesPublic);

export default router;
