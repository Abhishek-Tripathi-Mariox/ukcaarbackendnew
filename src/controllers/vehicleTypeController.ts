import { Request, Response } from 'express';
import { VehicleType, FuelType, User } from '../models';
import { AuthRequest } from '../middleware/auth';

/**
 * Dispatch radius for ride-type discovery — kept in sync with the same
 * radius used by `dispatchToNearbyDrivers` so what the customer sees on
 * the booking screen matches who actually receives the request.
 */
const NEARBY_RADIUS_KM = 7;

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
 * GET /api/v1/vehicle-types/nearby?lat=..&lng=..
 *
 * Returns the subset of active vehicle types that have at least one
 * online + available driver registered for them within 7 km of the
 * pickup. Used by the customer's ride-selection screen so we never show
 * a tile (e.g. "SUV") if no SUV driver is around to actually take the
 * trip — that's the difference between an Uber-style match and a
 * dead-end booking.
 *
 * Response groups types by `tier`:
 *   { instant: [{ type, availableCount }], private: [...] }
 */
export const listNearbyVehicleTypes = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const lat = parseFloat(req.query.lat as string);
    const lng = parseFloat(req.query.lng as string);
    if (!isFinite(lat) || !isFinite(lng)) {
      res
        .status(400)
        .json({ success: false, message: 'lat and lng query params are required' });
      return;
    }

    // 1. Find online drivers and post-filter by distance.
    //
    // We deliberately do NOT use $nearSphere here: the User schema stores
    // `currentLocation` as a plain `{lat, lng}` object, not a GeoJSON
    // Point. The 2dsphere index can't match that shape, so $nearSphere
    // returns zero drivers regardless of where they are — which is why
    // the customer was seeing a cab on the home map but "no cars within
    // 7 km" on the booking screen. We mirror /drivers/nearby's haversine
    // post-filter so what the booking screen counts matches what the map
    // shows. (A proper fix is to migrate currentLocation to GeoJSON +
    // 2dsphere everywhere, but that's a schema migration; this restores
    // working dispatch immediately.)
    //
    // We also drop the isAvailable=true requirement: the driver app sets
    // isOnline reliably but isAvailable is wired only to the ride
    // lifecycle (false during a trip). The map endpoint already shows
    // every isOnline driver — the customer-facing list must match.
    const drivers = await User.find({
      role: 'driver',
      'driverProfile.isOnline': true,
      isActive: true,
    }).select('_id driverProfile.vehicleTypeCode driverProfile.currentLocation');

    // Drivers approved on an active scheduled Route are shuttle drivers
    // — they shouldn't count toward instant / private dispatch
    // availability. Without this, the customer Home screen's "X cabs
    // nearby" badge and the Select Ride screen's tier counts both
    // double-counted shuttle drivers, even though those drivers can't
    // actually accept an instant request.
    const { Route } = await import('../models');
    const scheduledRoutes = await Route.find({
      isActive: true,
      type: 'scheduled',
      registeredDrivers: { $elemMatch: { status: 'approved' } },
    })
      .select('registeredDrivers')
      .lean();
    const scheduledDriverIds = new Set<string>();
    for (const r of scheduledRoutes) {
      for (const reg of (r.registeredDrivers ?? []) as any[]) {
        if (reg?.status === 'approved' && reg?.driver) {
          scheduledDriverIds.add(String(reg.driver));
        }
      }
    }

    // 2. Haversine in km. Same approximation /drivers/nearby uses — fine
    //    for a 7 km cutoff (error < 0.5% at this latitude/scale).
    const counts = new Map<string, number>();
    for (const d of drivers) {
      if (scheduledDriverIds.has(String((d as any)._id))) continue;
      const loc = (d as any).driverProfile?.currentLocation;
      const code = (d as any).driverProfile?.vehicleTypeCode;
      if (!code || !loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') continue;
      const dLat = loc.lat - lat;
      const dLng = loc.lng - lng;
      const distKm = Math.sqrt(dLat * dLat + dLng * dLng) * 111;
      if (distKm > NEARBY_RADIUS_KM) continue;
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }

    // 3. Pull the active vehicle-type catalogue and merge counts. Keep only
    //    types that actually have ≥1 driver near the pickup.
    const allTypes = await VehicleType.find({ isActive: true })
      .sort({ sortOrder: 1, name: 1 })
      .select('-__v');

    const grouped: { instant: any[]; private: any[] } = { instant: [], private: [] };
    for (const t of allTypes) {
      const available = counts.get(t.code) ?? 0;
      if (available <= 0) continue;
      const entry = {
        _id: t._id,
        name: t.name,
        code: t.code,
        description: t.description,
        tier: t.tier,
        availableCount: available,
        // Surface pricing so the customer SelectRide screen can show the
        // admin-configured fare without a second round-trip. Per-type
        // values; the legacy /rides/estimate buckets are still emitted
        // separately for code paths that haven't migrated yet.
        baseFare: t.baseFare,
        perKmFare: t.perKmFare,
        perMinFare: t.perMinFare,
        minFare: t.minFare,
        // Admin-configured seat capacity (undefined until set → app falls
        // back to its code heuristic).
        seats: t.seats,
      };
      if (t.tier === 'private') grouped.private.push(entry);
      else grouped.instant.push(entry);
    }

    res.status(200).json({
      success: true,
      data: {
        radiusKm: NEARBY_RADIUS_KM,
        instant: grouped.instant,
        private: grouped.private,
      },
    });
  } catch (error) {
    console.error('listNearbyVehicleTypes error:', error);
    res
      .status(500)
      .json({ success: false, message: 'Failed to fetch nearby vehicle types' });
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

// Coerce an incoming pricing field to a non-negative number, returning
// undefined for blank / non-numeric values so we don't accidentally write
// 0 (which would mean "free ride" instead of "not configured").
const num = (v: any): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

export const adminCreateVehicleType = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const {
      name, code, description, sortOrder, isActive, tier,
      baseFare, perKmFare, perMinFare, minFare,
    } = req.body ?? {};
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
      tier: tier === 'private' ? 'private' : 'instant',
      baseFare: num(baseFare),
      perKmFare: num(perKmFare),
      perMinFare: num(perMinFare),
      minFare: num(minFare),
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
    const {
      name, code, description, sortOrder, isActive, tier,
      baseFare, perKmFare, perMinFare, minFare,
    } = req.body ?? {};
    if (name !== undefined) updates.name = String(name).trim();
    // null = "clear this field" (fall back to the default), matching the UI
    // copy. Omitted keys keep their value; undefined never reaches here.
    const unset: Record<string, 1> = {};
    const setOrUnset = (key: string, raw: unknown, coerce: (v: any) => any) => {
      if (raw === undefined) return;
      if (raw === null || raw === '') unset[key] = 1;
      else updates[key] = coerce(raw);
    };
    if (code !== undefined) updates.code = String(code).toLowerCase().trim();
    setOrUnset('description', description, (v) => String(v));
    if (sortOrder !== undefined) updates.sortOrder = sortOrder;
    if (isActive !== undefined) updates.isActive = !!isActive;
    if (tier !== undefined) updates.tier = tier === 'private' ? 'private' : 'instant';
    setOrUnset('baseFare', baseFare, num);
    setOrUnset('perKmFare', perKmFare, num);
    setOrUnset('perMinFare', perMinFare, num);
    setOrUnset('minFare', minFare, num);

    const updateDoc: Record<string, any> = { $set: updates };
    if (Object.keys(unset).length) updateDoc.$unset = unset;
    const updated = await VehicleType.findByIdAndUpdate(id, updateDoc, { new: true });
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
