import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { Route } from '../models';
import { requirePermission } from '../middleware/auth';
import { auditLog } from '../middleware/audit';
import { PERMISSIONS } from '../config/permissions';

const router = Router();

// ──────────────────────────────────────────────────────────────────
// Validation helpers
// ──────────────────────────────────────────────────────────────────

function validateStops(stops: any): string | null {
  if (!Array.isArray(stops) || stops.length < 2) {
    return 'A route needs at least two stops';
  }
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i];
    if (!s || typeof s !== 'object') return `stops[${i}] must be an object`;
    if (typeof s.name !== 'string' || !s.name.trim())
      return `stops[${i}].name is required`;
    if (typeof s.lat !== 'number' || s.lat < -90 || s.lat > 90)
      return `stops[${i}].lat must be a number in [-90, 90]`;
    if (typeof s.lng !== 'number' || s.lng < -180 || s.lng > 180)
      return `stops[${i}].lng must be a number in [-180, 180]`;
    if (
      s.fareFromPrevious !== undefined &&
      s.fareFromPrevious !== null &&
      (typeof s.fareFromPrevious !== 'number' || s.fareFromPrevious < 0)
    )
      return `stops[${i}].fareFromPrevious must be a non-negative number`;
  }
  return null;
}

function validateSchedule(schedule: any): string | null {
  if (!schedule) return null;
  if (typeof schedule !== 'object') return 'schedule must be an object';
  if (schedule.daysOfWeek && !Array.isArray(schedule.daysOfWeek))
    return 'schedule.daysOfWeek must be an array';
  if (Array.isArray(schedule.daysOfWeek)) {
    for (const d of schedule.daysOfWeek) {
      if (typeof d !== 'number' || d < 0 || d > 6)
        return 'schedule.daysOfWeek values must be 0-6';
    }
  }
  if (schedule.departures) {
    if (!Array.isArray(schedule.departures))
      return 'schedule.departures must be an array';
    for (let i = 0; i < schedule.departures.length; i++) {
      const d = schedule.departures[i];
      if (!d || typeof d !== 'object') return `schedule.departures[${i}] invalid`;
      if (typeof d.stopIndex !== 'number' || d.stopIndex < 0)
        return `schedule.departures[${i}].stopIndex invalid`;
      if (typeof d.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(d.time))
        return `schedule.departures[${i}].time must be HH:mm`;
    }
  }
  if (
    schedule.seatPrice !== undefined &&
    (typeof schedule.seatPrice !== 'number' || schedule.seatPrice < 0)
  )
    return 'schedule.seatPrice must be a non-negative number';
  return null;
}

function normaliseBody(body: any) {
  const out: any = { ...body };
  if (Array.isArray(out.stops)) {
    out.stops = out.stops.map((s: any, i: number) => ({
      name: String(s.name).trim(),
      address: s.address ? String(s.address).trim() : undefined,
      lat: Number(s.lat),
      lng: Number(s.lng),
      sequence: typeof s.sequence === 'number' ? s.sequence : i,
      fareFromPrevious:
        i === 0
          ? 0
          : s.fareFromPrevious === undefined || s.fareFromPrevious === null || s.fareFromPrevious === ''
          ? 0
          : Number(s.fareFromPrevious),
    }));
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────
// Routes (the entity, not the express ones)
// ──────────────────────────────────────────────────────────────────

router.get(
  '/routes',
  requirePermission(PERMISSIONS.VIEW_ROUTES),
  async (req: Request, res: Response) => {
    try {
      const { type, isActive, search } = req.query;
      const filter: any = {};
      if (type) filter.type = type;
      if (isActive !== undefined) filter.isActive = isActive === 'true';
      if (search && typeof search === 'string' && search.trim()) {
        filter.name = { $regex: search.trim(), $options: 'i' };
      }
      const routes = await Route.find(filter).sort({ createdAt: -1 });
      res.json({ success: true, data: { routes } });
    } catch (err) {
      console.error('[routes] list error:', err);
      res.status(500).json({ success: false, message: 'Failed to load routes' });
    }
  }
);

router.get(
  '/routes/:id',
  requirePermission(PERMISSIONS.VIEW_ROUTES),
  async (req: Request, res: Response) => {
    try {
      const route = await Route.findById(req.params.id)
        .populate('assignedUsers', 'firstName lastName phone email')
        .populate('registeredDrivers.driver', 'firstName lastName phone email')
        .populate('createdBy', 'firstName lastName email');
      if (!route) {
        res.status(404).json({ success: false, message: 'Route not found' });
        return;
      }
      res.json({ success: true, data: { route } });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Failed to load route' });
    }
  }
);

router.post(
  '/routes',
  requirePermission(PERMISSIONS.MANAGE_ROUTES),
  auditLog({ action: 'route.create', resourceType: 'route' }),
  async (req: Request, res: Response) => {
    try {
      const body = normaliseBody(req.body);

      if (body.type !== 'private' && body.type !== 'scheduled') {
        res.status(400).json({
          success: false,
          message: 'type must be "private" or "scheduled"',
        });
        return;
      }
      const stopsErr = validateStops(body.stops);
      if (stopsErr) {
        res.status(400).json({ success: false, message: stopsErr });
        return;
      }
      const schedErr = validateSchedule(body.schedule);
      if (schedErr) {
        res.status(400).json({ success: false, message: schedErr });
        return;
      }

      const route = await Route.create({
        ...body,
        createdBy: (req as any).user?._id,
        registeredDrivers: [],
      });
      res.status(201).json({ success: true, data: { route } });
    } catch (err: any) {
      console.error('[routes] create error:', err);
      res
        .status(400)
        .json({ success: false, message: err.message || 'Create failed' });
    }
  }
);

router.patch(
  '/routes/:id',
  requirePermission(PERMISSIONS.MANAGE_ROUTES),
  auditLog({ action: 'route.update', resourceType: 'route' }),
  async (req: Request, res: Response) => {
    try {
      const body = normaliseBody(req.body);
      if (body.stops) {
        const e = validateStops(body.stops);
        if (e) {
          res.status(400).json({ success: false, message: e });
          return;
        }
      }
      if (body.schedule) {
        const e = validateSchedule(body.schedule);
        if (e) {
          res.status(400).json({ success: false, message: e });
          return;
        }
      }
      // Don't allow registeredDrivers to be overwritten via the generic update
      delete body.registeredDrivers;
      const route = await Route.findByIdAndUpdate(req.params.id, body, {
        new: true,
        runValidators: true,
      });
      if (!route) {
        res.status(404).json({ success: false, message: 'Route not found' });
        return;
      }
      res.json({ success: true, data: { route } });
    } catch (err: any) {
      res
        .status(400)
        .json({ success: false, message: err.message || 'Update failed' });
    }
  }
);

router.delete(
  '/routes/:id',
  requirePermission(PERMISSIONS.MANAGE_ROUTES),
  auditLog({ action: 'route.delete', resourceType: 'route' }),
  async (req: Request, res: Response) => {
    try {
      const route = await Route.findByIdAndDelete(req.params.id);
      if (!route) {
        res.status(404).json({ success: false, message: 'Route not found' });
        return;
      }
      res.json({ success: true, message: 'Route deleted' });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Delete failed' });
    }
  }
);

// ──────────────────────────────────────────────────────────────────
// Driver registrations on a route
// ──────────────────────────────────────────────────────────────────

router.patch(
  '/routes/:id/drivers/:driverId',
  requirePermission(PERMISSIONS.MANAGE_ROUTES),
  auditLog({ action: 'route.driver.update', resourceType: 'route' }),
  async (req: Request, res: Response) => {
    try {
      const { id, driverId } = req.params;
      const { status, note } = req.body || {};
      if (!['pending', 'approved', 'rejected', 'removed'].includes(status)) {
        res.status(400).json({ success: false, message: 'Invalid status' });
        return;
      }
      if (!mongoose.isValidObjectId(driverId)) {
        res.status(400).json({ success: false, message: 'Invalid driver id' });
        return;
      }

      const update: any = {
        'registeredDrivers.$.status': status,
      };
      if (note !== undefined) update['registeredDrivers.$.note'] = note;
      if (status === 'approved') {
        update['registeredDrivers.$.approvedAt'] = new Date();
        update['registeredDrivers.$.approvedBy'] = (req as any).user?._id;
      }

      const route = await Route.findOneAndUpdate(
        { _id: id, 'registeredDrivers.driver': driverId },
        { $set: update },
        { new: true }
      );
      if (!route) {
        res
          .status(404)
          .json({ success: false, message: 'Route or driver registration not found' });
        return;
      }
      res.json({ success: true, data: { route } });
    } catch (err: any) {
      res
        .status(400)
        .json({ success: false, message: err.message || 'Update failed' });
    }
  }
);

router.delete(
  '/routes/:id/drivers/:driverId',
  requirePermission(PERMISSIONS.MANAGE_ROUTES),
  auditLog({ action: 'route.driver.remove', resourceType: 'route' }),
  async (req: Request, res: Response) => {
    try {
      const { id, driverId } = req.params;
      const route = await Route.findByIdAndUpdate(
        id,
        { $pull: { registeredDrivers: { driver: driverId } } },
        { new: true }
      );
      if (!route) {
        res.status(404).json({ success: false, message: 'Route not found' });
        return;
      }
      res.json({ success: true, data: { route } });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Remove failed' });
    }
  }
);

// ──────────────────────────────────────────────────────────────────
// Assigned users on a private route
// ──────────────────────────────────────────────────────────────────

router.post(
  '/routes/:id/assigned-users',
  requirePermission(PERMISSIONS.MANAGE_ROUTES),
  auditLog({ action: 'route.user.assign', resourceType: 'route' }),
  async (req: Request, res: Response) => {
    try {
      const { userId } = req.body || {};
      if (!mongoose.isValidObjectId(userId)) {
        res.status(400).json({ success: false, message: 'Invalid user id' });
        return;
      }
      const route = await Route.findByIdAndUpdate(
        req.params.id,
        { $addToSet: { assignedUsers: userId } },
        { new: true }
      );
      if (!route) {
        res.status(404).json({ success: false, message: 'Route not found' });
        return;
      }
      res.json({ success: true, data: { route } });
    } catch (err: any) {
      res
        .status(400)
        .json({ success: false, message: err.message || 'Assign failed' });
    }
  }
);

router.delete(
  '/routes/:id/assigned-users/:userId',
  requirePermission(PERMISSIONS.MANAGE_ROUTES),
  auditLog({ action: 'route.user.unassign', resourceType: 'route' }),
  async (req: Request, res: Response) => {
    try {
      const route = await Route.findByIdAndUpdate(
        req.params.id,
        { $pull: { assignedUsers: req.params.userId } },
        { new: true }
      );
      if (!route) {
        res.status(404).json({ success: false, message: 'Route not found' });
        return;
      }
      res.json({ success: true, data: { route } });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Unassign failed' });
    }
  }
);

// ──────────────────────────────────────────────────────────────────
// Fare matrix (stop-to-stop). Read-only utility for admin/driver/customer
// previews. Returns an N×N matrix `matrix[i][j]` = fare for travelling
// FROM stop i TO stop j (0 if i>=j or not bookable).
// ──────────────────────────────────────────────────────────────────

router.get(
  '/routes/:id/fare-matrix',
  requirePermission(PERMISSIONS.VIEW_ROUTES),
  async (req: Request, res: Response) => {
    try {
      const route = await Route.findById(req.params.id).select('stops name');
      if (!route) {
        res.status(404).json({ success: false, message: 'Route not found' });
        return;
      }
      const stops = route.stops || [];
      const n = stops.length;
      const matrix: number[][] = Array.from({ length: n }, () =>
        Array(n).fill(0)
      );
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let j = i + 1; j < n; j++) {
          sum += Number(stops[j]?.fareFromPrevious || 0);
          matrix[i][j] = Math.round(sum * 100) / 100;
        }
      }
      res.json({
        success: true,
        data: {
          routeId: route._id,
          stops: stops.map((s, i) => ({
            index: i,
            name: s.name,
            fareFromPrevious: s.fareFromPrevious || 0,
          })),
          matrix,
          currency: 'GBP',
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Failed to build fare matrix' });
    }
  }
);

export default router;
