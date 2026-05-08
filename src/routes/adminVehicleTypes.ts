import { Router } from 'express';
import {
  adminListVehicleTypes,
  adminCreateVehicleType,
  adminUpdateVehicleType,
  adminDeleteVehicleType,
  adminListFuelTypes,
  adminCreateFuelType,
  adminUpdateFuelType,
  adminDeleteFuelType,
} from '../controllers/vehicleTypeController';

// Admin CRUD for vehicle and fuel types. Mounted under /admin so it
// inherits the authenticate + authorize('admin') middleware from
// routes/admin.ts.
const router = Router();

router.get('/vehicle-types', adminListVehicleTypes);
router.post('/vehicle-types', adminCreateVehicleType);
router.put('/vehicle-types/:id', adminUpdateVehicleType);
router.delete('/vehicle-types/:id', adminDeleteVehicleType);

router.get('/fuel-types', adminListFuelTypes);
router.post('/fuel-types', adminCreateFuelType);
router.put('/fuel-types/:id', adminUpdateFuelType);
router.delete('/fuel-types/:id', adminDeleteFuelType);

export default router;
