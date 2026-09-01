import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { istDateStr } from '../utils/date';
import { Route, User, ScheduledBooking } from '../models';
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

/**
 * Admin-tunable timing knobs on schedule. All optional — absent means "use
 * the platform default" (see utils/scheduleTiming.ts). Ranges mirror the
 * Route model schema so a clear message fires before Mongoose's terse one.
 */
const SCHEDULE_TIMING_LIMITS = [
  { key: 'bookingCutoffMinutes', min: 0, max: 720 },
  { key: 'maxAdvanceBookingDays', min: 1, max: 60 },
  { key: 'startWindowMinutes', min: 5, max: 720 },
  { key: 'minRestMinutes', min: 0, max: 1440 },
  { key: 'cancellationCutoffMinutes', min: 0, max: 1440 },
] as const;

function validateDepartureList(
  list: any,
  label: string,
  stopCount: number
): string | null {
  if (!Array.isArray(list)) return `schedule.${label} must be an array`;
  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    if (!d || typeof d !== 'object') return `schedule.${label}[${i}] invalid`;
    if (!Number.isInteger(d.stopIndex) || d.stopIndex < 0)
      return `schedule.${label}[${i}].stopIndex invalid`;
    if (d.stopIndex >= stopCount)
      return `schedule.${label}[${i}].stopIndex points past the last stop (this route has ${stopCount} stops)`;
    if (typeof d.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(d.time))
      return `schedule.${label}[${i}].time must be HH:mm`;
  }
  return null;
}

function validateSchedule(
  schedule: any,
  opts: { isScheduled: boolean; stopCount: number }
): string | null {
  if (!schedule) {
    return opts.isScheduled
      ? 'A scheduled route needs a schedule with at least one departure'
      : null;
  }
  if (typeof schedule !== 'object') return 'schedule must be an object';

  if (schedule.daysOfWeek !== undefined && !Array.isArray(schedule.daysOfWeek))
    return 'schedule.daysOfWeek must be an array';
  if (Array.isArray(schedule.daysOfWeek)) {
    for (const d of schedule.daysOfWeek) {
      if (!Number.isInteger(d) || d < 0 || d > 6)
        return 'schedule.daysOfWeek values must be integers 0 (Sunday) through 6 (Saturday)';
    }
  }
  // An empty daysOfWeek used to silently invert to "runs every day" further
  // down the stack — require an explicit choice for scheduled routes.
  if (
    opts.isScheduled &&
    !(Array.isArray(schedule.daysOfWeek) && schedule.daysOfWeek.length > 0)
  )
    return 'A scheduled route must run on at least one day of the week';

  if (schedule.departures !== undefined) {
    const e = validateDepartureList(
      schedule.departures,
      'departures',
      opts.stopCount
    );
    if (e) return e;
  }
  if (
    opts.isScheduled &&
    !(Array.isArray(schedule.departures) && schedule.departures.length > 0)
  )
    return 'A scheduled route needs at least one departure time';

  if (schedule.returnDepartures !== undefined && schedule.returnDepartures !== null) {
    const e = validateDepartureList(
      schedule.returnDepartures,
      'returnDepartures',
      opts.stopCount
    );
    if (e) return e;
  }

  if (
    schedule.seatPrice !== undefined &&
    (typeof schedule.seatPrice !== 'number' || schedule.seatPrice < 0)
  )
    return 'schedule.seatPrice must be a non-negative number';

  for (const { key, min, max } of SCHEDULE_TIMING_LIMITS) {
    const v = schedule[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
      return `schedule.${key} must be a whole number between ${min} and ${max}, or omitted to use the platform default`;
  }
  return null;
}

function normaliseBody(body: any) {
  const out: any = { ...body };
  if (Array.isArray(out.stops)) {
    out.stops = out.stops.map((s: any, i: number) => {
      // Accept an explicit pincode from the admin form. As a safety net,
      // try to parse one out of the address string when the form didn't
      // carry it (older clients, manually-typed addresses, etc.).
      const explicit =
        typeof s.pincode === 'string' ? s.pincode.trim() : undefined;
      const fromAddress: string | undefined = s.address
        ? (String(s.address).match(/\b\d{6}\b/g) ?? []).pop()
        : undefined;
      const pincode = explicit || fromAddress || undefined;
      return {
        name: String(s.name).trim(),
        address: s.address ? String(s.address).trim() : undefined,
        lat: Number(s.lat),
        lng: Number(s.lng),
        sequence: typeof s.sequence === 'number' ? s.sequence : i,
        fareFromPrevious:
          i === 0
            ? 0
            : s.fareFromPrevious === undefined ||
              s.fareFromPrevious === null ||
              s.fareFromPrevious === ''
            ? 0
            : Number(s.fareFromPrevious),
        pincode,
      };
    });
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
      const schedErr = validateSchedule(body.schedule, {
        isScheduled: body.type === 'scheduled',
        stopCount: body.stops.length,
      });
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
      const existing = await Route.findById(req.params.id);
      if (!existing) {
        res.status(404).json({ success: false, message: 'Route not found' });
        return;
      }
      if (body.stops) {
        const e = validateStops(body.stops);
        if (e) {
          res.status(400).json({ success: false, message: e });
          return;
        }
      }
      // Validate the schedule against the EFFECTIVE post-update state: a
      // patch that shrinks stops (or flips the type) without resending the
      // schedule must not leave departures pointing past the last stop.
      if (
        body.schedule !== undefined ||
        body.stops !== undefined ||
        body.type !== undefined
      ) {
        const effectiveType = body.type ?? existing.type;
        const effectiveStops = Array.isArray(body.stops)
          ? body.stops
          : existing.stops ?? [];
        const rawSchedule =
          body.schedule !== undefined ? body.schedule : existing.schedule;
        const effectiveSchedule =
          rawSchedule && typeof (rawSchedule as any).toObject === 'function'
            ? (rawSchedule as any).toObject()
            : rawSchedule;
        const e = validateSchedule(effectiveSchedule, {
          isScheduled: effectiveType === 'scheduled',
          stopCount: effectiveStops.length,
        });
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

// Admin directly assigns a driver to a route. Unlike the self-registration
// flow (driver app → POST /routes/:id/register, which lands as `pending`),
// an admin assignment is trusted and lands as `approved` straight away so
// the driver is immediately operational on the route. Drivers already on
// the route are rejected here — the UI disables them in the picker, and the
// admin should approve/reject/remove the existing entry instead.
router.post(
  '/routes/:id/drivers',
  requirePermission(PERMISSIONS.MANAGE_ROUTES),
  auditLog({ action: 'route.driver.assign', resourceType: 'route' }),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { driverId, status = 'approved', note } = req.body || {};

      if (!mongoose.isValidObjectId(driverId)) {
        res.status(400).json({ success: false, message: 'Invalid driver id' });
        return;
      }
      if (!['pending', 'approved'].includes(status)) {
        res
          .status(400)
          .json({ success: false, message: 'status must be "pending" or "approved"' });
        return;
      }

      const driver = await User.findOne({ _id: driverId, role: 'driver' }).select('_id');
      if (!driver) {
        res.status(404).json({ success: false, message: 'Driver not found' });
        return;
      }

      const route = await Route.findById(id);
      if (!route) {
        res.status(404).json({ success: false, message: 'Route not found' });
        return;
      }

      const already = route.registeredDrivers.some(
        (d) => String(d.driver) === String(driverId)
      );
      if (already) {
        res
          .status(409)
          .json({ success: false, message: 'Driver is already on this route' });
        return;
      }

      const reg: any = {
        driver: driverId,
        status,
        registeredAt: new Date(),
      };
      if (note !== undefined) reg.note = note;
      if (status === 'approved') {
        reg.approvedAt = new Date();
        reg.approvedBy = (req as any).user?._id;
      }
      route.registeredDrivers.push(reg);
      await route.save();

      const populated = await Route.findById(id).populate(
        'registeredDrivers.driver',
        'firstName lastName phone email'
      );
      res.status(201).json({ success: true, data: { route: populated } });
    } catch (err: any) {
      res.status(400).json({ success: false, message: err.message || 'Assign failed' });
    }
  }
);

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

        // Approving here IS the route switch: the driver's registration on
        // any other route is removed below, and journey generation follows
        // approved registrations only. Refuse while the driver still has
        // upcoming reserved bookings on those other routes — pulling the
        // registration would strand riders who already hold seats.
        const otherRouteIds = (
          await Route.find({
            _id: { $ne: id },
            type: 'scheduled',
            'registeredDrivers.driver': driverId,
          }).select('_id')
        ).map((r) => r._id);
        if (otherRouteIds.length > 0) {
          const committed = await ScheduledBooking.countDocuments({
            driver: driverId,
            route: { $in: otherRouteIds },
            status: 'reserved',
            departureDate: { $gte: istDateStr() },
          });
          if (committed > 0) {
            res.status(409).json({
              success: false,
              message: `This driver still has ${committed} upcoming booking${
                committed === 1 ? '' : 's'
              } on their current route. Complete or reassign those journeys before approving the change.`,
            });
            return;
          }
          await Route.updateMany(
            { _id: { $in: otherRouteIds } },
            { $pull: { registeredDrivers: { driver: driverId } } }
          );
        }
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
