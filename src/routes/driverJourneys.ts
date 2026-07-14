import { Router, Response } from 'express';
import mongoose from 'mongoose';
import {
  Route,
  ScheduledBooking,
  DriverJourney,
  IDriverJourney,
  Wallet,
  Payment,
  Settings,
} from '../models';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { config } from '../config';
import { emitToUser } from '../socket';
import { istDateStr } from '../utils/date';

const router = Router();
router.use(authenticate);
router.use(authorize('driver'));

// ── Journey identity ──
// A journey is uniquely (route, departureIndex, departureDate). We encode that
// as a URL-safe composite key `<routeId>_<index>_<YYYY-MM-DD>` so the list can
// reference journeys that don't have a DriverJourney doc yet (created lazily).
function makeKey(routeId: any, index: number, date: string): string {
  return `${String(routeId)}_${index}_${date}`;
}
function parseKey(key: string): { routeId: string; index: number; date: string } | null {
  const parts = String(key).split('_');
  if (parts.length !== 3) return null;
  const [routeId, idxStr, date] = parts;
  if (!mongoose.isValidObjectId(routeId)) return null;
  const index = Number(idxStr);
  if (!Number.isInteger(index) || index < 0) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return { routeId, index, date };
}

/** Resolve (or lazily create) the DriverJourney doc for a key + driver. */
async function resolveJourney(
  key: string,
  driverId: any,
): Promise<{ parsed: NonNullable<ReturnType<typeof parseKey>>; journey: IDriverJourney } | null> {
  const parsed = parseKey(key);
  if (!parsed) return null;
  const journey = await DriverJourney.findOneAndUpdate(
    {
      route: parsed.routeId,
      driver: driverId,
      departureIndex: parsed.index,
      departureDate: parsed.date,
    },
    { $setOnInsert: { status: 'scheduled', currentStopIndex: 0 } },
    { new: true, upsert: true },
  );
  return { parsed, journey: journey as IDriverJourney };
}

/** The departure-time label for a route slot index. */
function departureTime(routeDoc: any, index: number): string {
  const dep = routeDoc?.schedule?.departures?.[index];
  return dep?.time ?? '';
}

/** Shape a journey for the list/detail responses. */
async function shapeJourney(
  routeDoc: any,
  driverId: any,
  index: number,
  date: string,
  journey: IDriverJourney | null,
) {
  const bookings = await ScheduledBooking.find({
    route: routeDoc._id,
    driver: driverId,
    departureIndex: index,
    departureDate: date,
    status: { $in: ['reserved', 'completed'] },
  }).lean();

  const passengerCount = bookings.reduce((n, b) => n + (b.seats?.length ?? 0), 0);
  const boardedCount = bookings.reduce((n, b) => n + (b.boardedSeats?.length ?? 0), 0);

  return {
    journeyKey: makeKey(routeDoc._id, index, date),
    routeId: String(routeDoc._id),
    routeName: routeDoc.name,
    from: routeDoc.stops?.[0]?.name ?? '',
    to: routeDoc.stops?.[routeDoc.stops.length - 1]?.name ?? '',
    stopCount: routeDoc.stops?.length ?? 0,
    departureDate: date,
    departureIndex: index,
    departureTime: departureTime(routeDoc, index),
    seatPrice: routeDoc.schedule?.seatPrice ?? 0,
    totalSeats: routeDoc.schedule?.totalSeats ?? 0,
    status: journey?.status ?? 'scheduled',
    currentStopIndex: journey?.currentStopIndex ?? 0,
    passengerCount,
    boardedCount,
    bookingCount: bookings.length,
    startedAt: journey?.startedAt ?? null,
    completedAt: journey?.completedAt ?? null,
    earnings: journey?.earnings ?? 0,
  };
}

/**
 * GET /api/v1/drivers/journeys?scope=upcoming|past
 * Journeys derived from this driver's bookings, merged with any journey state.
 */
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const scope = (req.query.scope as string) === 'past' ? 'past' : 'upcoming';
    const todayStr = istDateStr(); // IST civil date — matches how the booking date was chosen
    const driverId = req.user!._id;

    // Distinct (route, departureIndex, departureDate) groups this driver has bookings for.
    const groups = await ScheduledBooking.aggregate([
      { $match: { driver: new mongoose.Types.ObjectId(driverId), status: { $in: ['reserved', 'completed'] } } },
      {
        $group: {
          _id: { route: '$route', departureIndex: '$departureIndex', departureDate: '$departureDate' },
        },
      },
    ]);

    // Load this driver's journey docs first — scope depends on STATUS, not just
    // the date. A journey is "past" once it's finished (completed/cancelled) OR
    // its departure date has passed; everything else is "upcoming" (including a
    // trip that's active/in_progress today). Date-only would wrongly leave a
    // completed-today trip sitting in the upcoming tab.
    const journeys = await DriverJourney.find({ driver: driverId }).lean();
    const jMap = new Map(
      journeys.map((j) => [makeKey(j.route, j.departureIndex, j.departureDate), j]),
    );

    const existingKeys = new Set(
      groups.map((g) => makeKey(g._id.route, g._id.departureIndex, g._id.departureDate))
    );
    for (const j of journeys) {
      const key = makeKey(j.route, j.departureIndex, j.departureDate);
      if (!existingKeys.has(key)) {
        groups.push({
          _id: { route: j.route, departureIndex: j.departureIndex, departureDate: j.departureDate },
        });
        existingKeys.add(key);
      }
    }

    const myRoutes = await Route.find({
      isActive: true,
      type: 'scheduled',
      $or: [
        { 'registeredDrivers.driver': new mongoose.Types.ObjectId(driverId) },
        { driver: new mongoose.Types.ObjectId(driverId) },
      ],
    }).lean();

    const routesToCheck =
      myRoutes.length > 0
        ? myRoutes
        : await Route.find({ isActive: true, type: 'scheduled' }).lean();

    for (const r of routesToCheck) {
      const departures = r.schedule?.departures || [];
      const daysOfWeek = r.schedule?.daysOfWeek || [0, 1, 2, 3, 4, 5, 6];
      for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
        const d = new Date();
        d.setDate(d.getDate() + dayOffset);
        const dayNum = d.getDay();
        if (daysOfWeek.length > 0 && !daysOfWeek.includes(dayNum)) continue;
        const dateStr = d.toISOString().slice(0, 10);
        for (let depIdx = 0; depIdx < departures.length; depIdx++) {
          const key = makeKey(r._id, depIdx, dateStr);
          if (!existingKeys.has(key)) {
            groups.push({
              _id: { route: r._id, departureIndex: depIdx, departureDate: dateStr },
            });
            existingKeys.add(key);
          }
        }
      }
    }
    const isPast = (g: any): boolean => {
      const key = makeKey(g._id.route, g._id.departureIndex, g._id.departureDate);
      const status = (jMap.get(key) as IDriverJourney | undefined)?.status;
      if (status === 'completed' || status === 'cancelled') return true;
      return g._id.departureDate < todayStr;
    };

    const filtered = groups.filter((g) => (scope === 'past' ? isPast(g) : !isPast(g)));

    const routeIds = [...new Set(filtered.map((g) => String(g._id.route)))];
    const routes = await Route.find({ _id: { $in: routeIds } }).lean();
    const routeMap = new Map(routes.map((r) => [String(r._id), r]));

    const items = (
      await Promise.all(
        filtered.map(async (g) => {
          const routeDoc = routeMap.get(String(g._id.route));
          if (!routeDoc) return null;
          const key = makeKey(g._id.route, g._id.departureIndex, g._id.departureDate);
          const j = (jMap.get(key) as IDriverJourney | undefined) ?? null;
          return shapeJourney(routeDoc, driverId, g._id.departureIndex, g._id.departureDate, j);
        }),
      )
    ).filter(Boolean);

    // Sort: upcoming ascending by date+time, past descending.
    items.sort((a: any, b: any) => {
      const ka = `${a.departureDate} ${a.departureTime}`;
      const kb = `${b.departureDate} ${b.departureTime}`;
      return scope === 'past' ? kb.localeCompare(ka) : ka.localeCompare(kb);
    });

    res.json({ success: true, data: { items } });
  } catch (err) {
    console.error('[Journeys list] error:', err);
    res.status(500).json({ success: false, message: 'Failed to load journeys' });
  }
});

/**
 * GET /api/v1/drivers/journeys/:key
 * Journey detail: route, stops, departure, passenger/boarded counts, status.
 */
router.get('/:key', async (req: AuthRequest, res: Response) => {
  try {
    const resolved = await resolveJourney(req.params.key, req.user!._id);
    if (!resolved) {
      res.status(400).json({ success: false, message: 'Invalid journey' });
      return;
    }
    const routeDoc = await Route.findById(resolved.parsed.routeId).lean();
    if (!routeDoc) {
      res.status(404).json({ success: false, message: 'Route not found' });
      return;
    }
    const summary = await shapeJourney(
      routeDoc,
      req.user!._id,
      resolved.parsed.index,
      resolved.parsed.date,
      resolved.journey,
    );
    const stops = (routeDoc.stops ?? [])
      .slice()
      .sort((a: any, b: any) => (a.sequence ?? 0) - (b.sequence ?? 0))
      .map((s: any, i: number) => ({ index: i, name: s.name, sequence: s.sequence ?? i }));

    res.json({ success: true, data: { journey: summary, stops } });
  } catch (err) {
    console.error('[Journey detail] error:', err);
    res.status(500).json({ success: false, message: 'Failed to load journey' });
  }
});

/**
 * GET /api/v1/drivers/journeys/:key/passengers
 * Flattened passenger manifest with per-seat boarded status.
 */
router.get('/:key/passengers', async (req: AuthRequest, res: Response) => {
  try {
    const parsed = parseKey(req.params.key);
    if (!parsed) {
      res.status(400).json({ success: false, message: 'Invalid journey' });
      return;
    }
    const bookings = await ScheduledBooking.find({
      route: parsed.routeId,
      driver: req.user!._id,
      departureIndex: parsed.index,
      departureDate: parsed.date,
      status: { $in: ['reserved', 'completed'] },
    })
      .populate('customer', 'firstName lastName phone')
      .lean();

    const passengers: any[] = [];
    for (const b of bookings) {
      const boarded = new Set(b.boardedSeats ?? []);
      const noShow = new Set(b.noShowSeats ?? []);
      for (const seat of b.seats ?? []) {
        const pax = (b.passengers ?? []).find((p) => p.seat === seat);
        const cust: any = b.customer;
        passengers.push({
          bookingId: String(b._id),
          seat,
          name:
            pax?.name ||
            [cust?.firstName, cust?.lastName].filter(Boolean).join(' ') ||
            'Passenger',
          contact: pax?.contact || cust?.phone || '',
          boarded: boarded.has(seat),
          noShow: noShow.has(seat),
        });
      }
    }
    passengers.sort((a, b) => a.seat - b.seat);

    res.json({
      success: true,
      data: {
        passengers,
        total: passengers.length,
        boarded: passengers.filter((p) => p.boarded).length,
        noShow: passengers.filter((p) => p.noShow).length,
      },
    });
  } catch (err) {
    console.error('[Journey passengers] error:', err);
    res.status(500).json({ success: false, message: 'Failed to load passengers' });
  }
});

/**
 * POST /api/v1/drivers/journeys/:key/start
 * Activate the journey (status -> active, position at the boarding stop).
 */
router.post('/:key/start', async (req: AuthRequest, res: Response) => {
  try {
    const resolved = await resolveJourney(req.params.key, req.user!._id);
    if (!resolved) {
      res.status(400).json({ success: false, message: 'Invalid journey' });
      return;
    }
    const { journey, parsed } = resolved;
    if (journey.status === 'completed' || journey.status === 'cancelled') {
      res.status(400).json({ success: false, message: 'Journey already finished' });
      return;
    }
    // A trip can't be started before its scheduled date — that's how a
    // tomorrow trip was being completed today and polluting the lists.
    if (parsed.date > istDateStr()) {
      res.status(400).json({
        success: false,
        message: 'This journey is scheduled for a future date and cannot be started yet.',
      });
      return;
    }
    const routeDoc = await Route.findById(parsed.routeId).lean();
    const boardingStopIndex = routeDoc?.schedule?.departures?.[parsed.index]?.stopIndex ?? 0;

    if (journey.status === 'scheduled') {
      journey.status = 'active';
      journey.startedAt = new Date();
      journey.currentStopIndex = boardingStopIndex;
      await journey.save();
    }
    res.json({ success: true, data: { status: journey.status, currentStopIndex: journey.currentStopIndex } });
  } catch (err) {
    console.error('[Journey start] error:', err);
    res.status(500).json({ success: false, message: 'Failed to start journey' });
  }
});

/** Mark seats boarded on a booking that belongs to this journey + driver. */
async function boardSeats(
  parsed: { routeId: string; index: number; date: string },
  driverId: any,
  bookingRef: string,
  seats?: number[],
): Promise<{ ok: boolean; message?: string; passenger?: any }> {
  if (!bookingRef) return { ok: false, message: 'Invalid ticket' };

  // The scope every match must satisfy: a reserved booking on THIS journey.
  const scope = {
    route: parsed.routeId,
    driver: driverId,
    departureIndex: parsed.index,
    departureDate: parsed.date,
    status: 'reserved' as const,
  };

  let booking;
  if (mongoose.isValidObjectId(bookingRef)) {
    booking = await ScheduledBooking.findOne({ _id: bookingRef, ...scope }).populate(
      'customer',
      'firstName lastName phone',
    );
  } else {
    // Manual entry path: the customer ticket shows an 8-char reference (the
    // tail of the booking id). Match it against this journey's bookings.
    const ref = String(bookingRef).trim().toUpperCase();
    const candidates = await ScheduledBooking.find(scope).populate(
      'customer',
      'firstName lastName phone',
    );
    booking = candidates.find((b) => String(b._id).toUpperCase().endsWith(ref)) ?? null;
  }
  if (!booking) return { ok: false, message: 'Ticket is not valid for this journey' };

  // Default: board every seat on the booking; or just the seats requested.
  const target = (seats && seats.length ? seats : booking.seats).filter((s) =>
    booking.seats.includes(s),
  );
  const set = new Set(booking.boardedSeats ?? []);
  target.forEach((s) => set.add(s));
  booking.boardedSeats = [...set].sort((a, b) => a - b);
  // Boarding overrides a prior no-show for the same seat (rider showed up).
  if (booking.noShowSeats?.length) {
    booking.noShowSeats = booking.noShowSeats.filter((s) => !target.includes(s));
  }
  if (!booking.boardedAt) booking.boardedAt = new Date();
  await booking.save();

  const cust: any = booking.customer;
  return {
    ok: true,
    passenger: {
      bookingId: String(booking._id),
      name: [cust?.firstName, cust?.lastName].filter(Boolean).join(' ') || 'Passenger',
      seats: booking.seats,
      boardedSeats: booking.boardedSeats,
      contact: cust?.phone || '',
    },
  };
}

/**
 * POST /api/v1/drivers/journeys/:key/checkin
 * Manual check-in. Body: { bookingId, seats? }
 */
router.post('/:key/checkin', async (req: AuthRequest, res: Response) => {
  try {
    const parsed = parseKey(req.params.key);
    if (!parsed) {
      res.status(400).json({ success: false, message: 'Invalid journey' });
      return;
    }
    const { bookingId, seats } = req.body || {};
    const result = await boardSeats(parsed, req.user!._id, bookingId, seats);
    if (!result.ok) {
      res.status(400).json({ success: false, message: result.message });
      return;
    }
    res.json({ success: true, data: { passenger: result.passenger } });
  } catch (err) {
    console.error('[Journey checkin] error:', err);
    res.status(500).json({ success: false, message: 'Check-in failed' });
  }
});

/** Mark seats no-show on a booking that belongs to this journey + driver. */
async function noShowSeats(
  parsed: { routeId: string; index: number; date: string },
  driverId: any,
  bookingId: string,
  seats?: number[],
): Promise<{ ok: boolean; message?: string; passenger?: any }> {
  if (!bookingId || !mongoose.isValidObjectId(bookingId)) {
    return { ok: false, message: 'Invalid booking' };
  }
  const booking = await ScheduledBooking.findOne({
    _id: bookingId,
    route: parsed.routeId,
    driver: driverId,
    departureIndex: parsed.index,
    departureDate: parsed.date,
    status: 'reserved',
  }).populate('customer', 'firstName lastName phone');
  if (!booking) return { ok: false, message: 'Booking is not valid for this journey' };

  // Target the requested seats (or all of the booking's), clamped to its seats.
  const target = (seats && seats.length ? seats : booking.seats).filter((s) =>
    booking.seats.includes(s),
  );
  const set = new Set(booking.noShowSeats ?? []);
  target.forEach((s) => set.add(s));
  booking.noShowSeats = [...set].sort((a, b) => a - b);
  // A no-show seat can't also be boarded.
  if (booking.boardedSeats?.length) {
    booking.boardedSeats = booking.boardedSeats.filter((s) => !target.includes(s));
  }
  await booking.save();

  const cust: any = booking.customer;
  return {
    ok: true,
    passenger: {
      bookingId: String(booking._id),
      name: [cust?.firstName, cust?.lastName].filter(Boolean).join(' ') || 'Passenger',
      seats: booking.seats,
      noShowSeats: booking.noShowSeats,
    },
  };
}

/**
 * POST /api/v1/drivers/journeys/:key/no-show
 * Mark a rider's seat(s) as no-show. Body: { bookingId, seats? }. Excluded from
 * settlement; any fare refund is handled by admin, not auto-processed here.
 */
router.post('/:key/no-show', async (req: AuthRequest, res: Response) => {
  try {
    const parsed = parseKey(req.params.key);
    if (!parsed) {
      res.status(400).json({ success: false, message: 'Invalid journey' });
      return;
    }
    const { bookingId, seats } = req.body || {};
    const result = await noShowSeats(parsed, req.user!._id, bookingId, seats);
    if (!result.ok) {
      res.status(400).json({ success: false, message: result.message });
      return;
    }
    res.json({ success: true, data: { passenger: result.passenger } });
  } catch (err) {
    console.error('[Journey no-show] error:', err);
    res.status(500).json({ success: false, message: 'Failed to mark no-show' });
  }
});

/**
 * POST /api/v1/drivers/journeys/:key/verify-qr
 * Scan a rider's ticket QR. Body: { qr } — the QR's JSON payload (or bookingId).
 */
router.post('/:key/verify-qr', async (req: AuthRequest, res: Response) => {
  try {
    const parsed = parseKey(req.params.key);
    if (!parsed) {
      res.status(400).json({ success: false, message: 'Invalid journey' });
      return;
    }
    const raw = req.body?.qr;
    let bookingId: string | undefined;
    if (typeof raw === 'string') {
      try {
        const obj = JSON.parse(raw);
        bookingId = obj?.bookingId || obj?.id;
      } catch {
        bookingId = raw; // a bare bookingId string
      }
    } else if (raw && typeof raw === 'object') {
      bookingId = raw.bookingId || raw.id;
    }
    if (!bookingId) {
      res.status(400).json({ success: false, valid: false, message: 'Unreadable ticket' });
      return;
    }
    const result = await boardSeats(parsed, req.user!._id, bookingId);
    if (!result.ok) {
      res.status(400).json({ success: false, valid: false, message: result.message });
      return;
    }
    res.json({ success: true, valid: true, data: { passenger: result.passenger } });
  } catch (err) {
    console.error('[Journey verify-qr] error:', err);
    res.status(500).json({ success: false, valid: false, message: 'QR verification failed' });
  }
});

/**
 * POST /api/v1/drivers/journeys/:key/advance
 * Move the shuttle to the next stop (or an explicit toStopIndex). Body: { toStopIndex? }
 */
router.post('/:key/advance', async (req: AuthRequest, res: Response) => {
  try {
    const resolved = await resolveJourney(req.params.key, req.user!._id);
    if (!resolved) {
      res.status(400).json({ success: false, message: 'Invalid journey' });
      return;
    }
    const { journey, parsed } = resolved;
    if (journey.status === 'completed' || journey.status === 'cancelled') {
      res.status(400).json({ success: false, message: 'Journey already finished' });
      return;
    }
    const routeDoc = await Route.findById(parsed.routeId).lean();
    const lastStop = Math.max(0, (routeDoc?.stops?.length ?? 1) - 1);

    const explicit = Number(req.body?.toStopIndex);
    const next = Number.isInteger(explicit)
      ? Math.min(Math.max(explicit, 0), lastStop)
      : Math.min(journey.currentStopIndex + 1, lastStop);

    journey.status = 'in_progress';
    journey.currentStopIndex = next;
    await journey.save();

    res.json({
      success: true,
      data: {
        currentStopIndex: journey.currentStopIndex,
        atDestination: journey.currentStopIndex >= lastStop,
      },
    });
  } catch (err) {
    console.error('[Journey advance] error:', err);
    res.status(500).json({ success: false, message: 'Failed to advance journey' });
  }
});

/**
 * POST /api/v1/drivers/journeys/:key/complete
 * Finish the trip and settle the driver's earnings (their share of the
 * boarded seats' fares). Passengers already paid at booking time.
 */
router.post('/:key/complete', async (req: AuthRequest, res: Response) => {
  try {
    const resolved = await resolveJourney(req.params.key, req.user!._id);
    if (!resolved) {
      res.status(400).json({ success: false, message: 'Invalid journey' });
      return;
    }
    const { journey, parsed } = resolved;
    if (journey.status === 'completed') {
      res.json({ success: true, data: { earnings: journey.earnings, alreadyCompleted: true } });
      return;
    }
    // Can't settle a trip before its scheduled date (defense-in-depth alongside
    // the start guard).
    if (parsed.date > istDateStr()) {
      res.status(400).json({
        success: false,
        message: 'This journey is scheduled for a future date and cannot be completed yet.',
      });
      return;
    }

    const bookings = await ScheduledBooking.find({
      route: parsed.routeId,
      driver: req.user!._id,
      departureIndex: parsed.index,
      departureDate: parsed.date,
      status: 'reserved',
    }).lean();

    // Gross = the paid amount attributable to boarded seats. If a booking has
    // no per-seat split we prorate totalAmount across its seats.
    let gross = 0;
    let boardedSeatCount = 0;
    for (const b of bookings) {
      const seats = b.seats?.length ?? 0;
      const boarded = (b.boardedSeats ?? []).length;
      boardedSeatCount += boarded;
      if (seats > 0 && b.totalAmount) {
        gross += (b.totalAmount / seats) * boarded;
      }
    }
    gross = Math.round(gross * 100) / 100;

    // Driver share = gross minus platform commission.
    const settings = await Settings.findOne({ key: 'platform' }).select('commissionRate').lean();
    const commissionRate = settings?.commissionRate ?? config.ride.commissionRate ?? 0.2;
    const earnings = Math.round(gross * (1 - commissionRate) * 100) / 100;

    journey.status = 'completed';
    journey.completedAt = new Date();
    journey.earnings = earnings;
    await journey.save();

    // Finalize the trip's bookings so the RIDER sees them as completed (not
    // stuck as an active/upcoming reservation). Notify each customer.
    const finalized = await ScheduledBooking.find({
      route: parsed.routeId,
      driver: req.user!._id,
      departureIndex: parsed.index,
      departureDate: parsed.date,
      status: 'reserved',
    }).select('customer');
    await ScheduledBooking.updateMany(
      {
        route: parsed.routeId,
        driver: req.user!._id,
        departureIndex: parsed.index,
        departureDate: parsed.date,
        status: 'reserved',
      },
      { $set: { status: 'completed' } },
    );
    for (const b of finalized) {
      emitToUser(String(b.customer), 'scheduled:completed', {
        bookingId: String(b._id),
      });
    }

    if (earnings > 0) {
      await Wallet.findOneAndUpdate(
        { user: req.user!._id },
        { $inc: { balance: earnings } },
        { upsert: true },
      );
      await Payment.create({
        user: req.user!._id,
        type: 'ride_payment',
        amount: earnings,
        method: 'wallet',
        status: 'completed',
        description: `Scheduled journey earnings (${boardedSeatCount} passengers)`,
      });
    }

    emitToUser(String(req.user!._id), 'journey:completed', {
      journeyKey: makeKey(parsed.routeId, parsed.index, parsed.date),
      earnings,
    });

    res.json({
      success: true,
      data: { earnings, boardedSeatCount, gross },
    });
  } catch (err) {
    console.error('[Journey complete] error:', err);
    res.status(500).json({ success: false, message: 'Failed to complete journey' });
  }
});

export default router;
