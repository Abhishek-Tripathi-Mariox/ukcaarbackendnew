import { Request, Response } from 'express';
import { VehicleType, FuelType } from '../models';
import { AuthRequest } from '../middleware/auth';

/**
 * Slugifies a string to produce a stable code from a display name.
 * "Mini Truck" → "mini-truck"
 */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

// ════════════════════════════════════════════════════════════════════
// PUBLIC (authenticated) — used by the driver app's vehicle-details form
// ════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/vehicle-types
 * Returns active vehicle types ordered for display.
 */
export const listVehicleTypesPublic = async (
  _req: Request,
  res: Response
): Promise<void> => {
  try {
    const types = await VehicleType.find({ isActive: true })
      .sort({ sortOrder: 1, name: 1 })
      .select('-__v');
    res.status(200).json({ success: true, data: { types } });
  } catch (error) {
    console.error('listVehicleTypesPublic error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch vehicle types' });
  }
};

/**
 * GET /api/v1/fuel-types
 * Returns active fuel types ordered for display.
 */
export const listFuelTypesPublic = async (
  _req: Request,
  res: Response
): Promise<void> => {
  try {
    const types = await FuelType.find({ isActive: true })
      .sort({ sortOrder: 1, name: 1 })
      .select('-__v');
    res.status(200).json({ success: true, data: { types } });
  } catch (error) {
    console.error('listFuelTypesPublic error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch fuel types' });
  }
};

// ════════════════════════════════════════════════════════════════════
// ADMIN CRUD
// ════════════════════════════════════════════════════════════════════

// ---- Vehicle types ------------------------------------------------------

export const adminListVehicleTypes = async (
  _req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const types = await VehicleType.find().sort({ sortOrder: 1, name: 1 });
    res.status(200).json({ success: true, data: { types } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch vehicle types' });
  }
};

export const adminCreateVehicleType = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { name, code, description, sortOrder, isActive } = req.body ?? {};
    if (!name) {
      res.status(400).json({ success: false, message: 'name is required' });
      return;
    }
    const finalCode = (code ? String(code) : slugify(name)).toLowerCase();
    const created = await VehicleType.create({
      name: String(name).trim(),
      code: finalCode,
      description,
      sortOrder: typeof sortOrder === 'number' ? sortOrder : 0,
      isActive: isActive === undefined ? true : !!isActive,
    });
    res.status(201).json({ success: true, data: { type: created } });
  } catch (error: any) {
    if (error?.code === 11000) {
      res.status(409).json({ success: false, message: 'A vehicle type with that code already exists.' });
      return;
    }
    console.error('adminCreateVehicleType error:', error);
    res.status(500).json({ success: false, message: 'Failed to create vehicle type' });
  }
};

export const adminUpdateVehicleType = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { id } = req.params;
    const updates: Record<string, any> = {};
    const { name, code, description, sortOrder, isActive } = req.body ?? {};
    if (name !== undefined) updates.name = String(name).trim();
    if (code !== undefined) updates.code = String(code).toLowerCase().trim();
    if (description !== undefined) updates.description = description;
    if (sortOrder !== undefined) updates.sortOrder = sortOrder;
    if (isActive !== undefined) updates.isActive = !!isActive;

    const updated = await VehicleType.findByIdAndUpdate(id, updates, { new: true });
    if (!updated) {
      res.status(404).json({ success: false, message: 'Vehicle type not found' });
      return;
    }
    res.status(200).json({ success: true, data: { type: updated } });
  } catch (error: any) {
    if (error?.code === 11000) {
      res.status(409).json({ success: false, message: 'Code already in use.' });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to update vehicle type' });
  }
};

export const adminDeleteVehicleType = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { id } = req.params;
    const deleted = await VehicleType.findByIdAndDelete(id);
    if (!deleted) {
      res.status(404).json({ success: false, message: 'Vehicle type not found' });
      return;
    }
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to delete vehicle type' });
  }
};

// ---- Fuel types ---------------------------------------------------------

export const adminListFuelTypes = async (
  _req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const types = await FuelType.find().sort({ sortOrder: 1, name: 1 });
    res.status(200).json({ success: true, data: { types } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch fuel types' });
  }
};

export const adminCreateFuelType = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { name, code, description, sortOrder, isActive } = req.body ?? {};
    if (!name) {
      res.status(400).json({ success: false, message: 'name is required' });
      return;
    }
    const finalCode = (code ? String(code) : slugify(name)).toLowerCase();
    const created = await FuelType.create({
      name: String(name).trim(),
      code: finalCode,
      description,
      sortOrder: typeof sortOrder === 'number' ? sortOrder : 0,
      isActive: isActive === undefined ? true : !!isActive,
    });
    res.status(201).json({ success: true, data: { type: created } });
  } catch (error: any) {
    if (error?.code === 11000) {
      res.status(409).json({ success: false, message: 'A fuel type with that code already exists.' });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to create fuel type' });
  }
};

export const adminUpdateFuelType = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { id } = req.params;
    const updates: Record<string, any> = {};
    const { name, code, description, sortOrder, isActive } = req.body ?? {};
    if (name !== undefined) updates.name = String(name).trim();
    if (code !== undefined) updates.code = String(code).toLowerCase().trim();
    if (description !== undefined) updates.description = description;
    if (sortOrder !== undefined) updates.sortOrder = sortOrder;
    if (isActive !== undefined) updates.isActive = !!isActive;

    const updated = await FuelType.findByIdAndUpdate(id, updates, { new: true });
    if (!updated) {
      res.status(404).json({ success: false, message: 'Fuel type not found' });
      return;
    }
    res.status(200).json({ success: true, data: { type: updated } });
  } catch (error: any) {
    if (error?.code === 11000) {
      res.status(409).json({ success: false, message: 'Code already in use.' });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to update fuel type' });
  }
};

export const adminDeleteFuelType = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { id } = req.params;
    const deleted = await FuelType.findByIdAndDelete(id);
    if (!deleted) {
      res.status(404).json({ success: false, message: 'Fuel type not found' });
      return;
    }
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to delete fuel type' });
  }
};
