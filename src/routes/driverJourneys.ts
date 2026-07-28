import { Router, Response } from 'express';
import mongoose from 'mongoose';
import {
  Route,
  ScheduledBooking,
  DriverJourney,
  IDriverJourney,
  User,
  Wallet,
  Payment,
  Settings,
} from '../models';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { requireApprovedDriver } from '../middleware/driverApproval';
import { config } from '../config';
import { emitToUser } from '../socket';
import { distanceMeters } from '../utils/routeCorridor';
import { istDateStr, istWeekday, istDateStrPlusDays } from '../utils/date';

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

// ── Early-drop partial-fare math ──
// A rider who gets off before their booked stop is refunded the fare for the
// distance they DIDN'T travel. We measure how far the bus actually carried them
// and prorate `totalAmount` over that. "How far" is derived, most-reliable
// first: (1) the stop nearest the driver's live GPS, (2) the journey's current
// stop, (3) a 50/50 split when neither signal exists. Fare is weighted by the
// route's per-segment `fareFromPrevious` when configured, else by geographic
// distance between stops.
function computeEarlyDropFare(
  routeDoc: any,
  booking: any,
  driverLoc: { lat: number; lng: number } | null,
  journey: any,
): { originalFare: number; partialFare: number; refund: number; dropStopSequence: number; dropStopName: string } {
  const originalFare = Math.max(0, Math.round(Number(booking.totalAmount) || 0));
  const stops = [...(routeDoc?.stops ?? [])].sort(
    (a: any, b: any) => (a.sequence ?? 0) - (b.sequence ?? 0),
  );
  const seqOf = (s: any) => s.sequence ?? 0;
  if (stops.length < 2) {
    return { originalFare, partialFare: originalFare, refund: 0, dropStopSequence: 0, dropStopName: '' };
  }
  const minSeq = seqOf(stops[0]);
  const maxSeq = seqOf(stops[stops.length - 1]);
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
  const bSeq = clamp(
    Number.isInteger(booking.boardingStopSequence) ? booking.boardingStopSequence : minSeq,
    minSeq,
    maxSeq,
  );
  const dSeq = clamp(
    Number.isInteger(booking.droppingStopSequence) ? booking.droppingStopSequence : maxSeq,
    bSeq,
    maxSeq,
  );
  const nameOf = (seq: number) => stops.find((s: any) => seqOf(s) === seq)?.name ?? '';
  if (dSeq <= bSeq || originalFare <= 0) {
    return { originalFare, partialFare: originalFare, refund: 0, dropStopSequence: dSeq, dropStopName: nameOf(dSeq) };
  }

  const inSegment = stops.filter((s: any) => seqOf(s) >= bSeq && seqOf(s) <= dSeq);

  // Where did the bus drop them?
  let dropSeq: number | null = null;
  if (driverLoc && typeof driverLoc.lat === 'number' && typeof driverLoc.lng === 'number') {
    let best: { seq: number; m: number } | null = null;
    for (const s of inSegment) {
      const m = distanceMeters(driverLoc, { lat: s.lat, lng: s.lng });
      if (!best || m < best.m) best = { seq: seqOf(s), m };
    }
    if (best) dropSeq = best.seq;
  }
  if (dropSeq == null && journey && Number.isInteger(journey.currentStopIndex)) {
    const cs = routeDoc?.stops?.[journey.currentStopIndex];
    if (cs) dropSeq = clamp(seqOf(cs), bSeq, dSeq);
  }

  const fareBetween = (from: number, to: number) =>
    stops
      .filter((s: any) => seqOf(s) > from && seqOf(s) <= to)
      .reduce((sum: number, s: any) => sum + (s.fareFromPrevious ?? 0), 0);
  const distBetween = (from: number, to: number) => {
    const seg = stops.filter((s: any) => seqOf(s) >= from && seqOf(s) <= to);
    let d = 0;
    for (let i = 1; i < seg.length; i++) {
      d += distanceMeters(
        { lat: seg[i - 1].lat, lng: seg[i - 1].lng },
        { lat: seg[i].lat, lng: seg[i].lng },
      );
    }
    return d;
  };

  let fraction: number;
  if (dropSeq == null) {
    fraction = 0.5; // no position signal — split the fare fairly
  } else {
    dropSeq = clamp(dropSeq, bSeq, dSeq);
    const totalFare = fareBetween(bSeq, dSeq);
    if (totalFare > 0) {
      fraction = fareBetween(bSeq, dropSeq) / totalFare;
    } else {
      const totalD = distBetween(bSeq, dSeq);
      fraction = totalD > 0 ? distBetween(bSeq, dropSeq) / totalD : 0.5;
    }
  }
  fraction = clamp(fraction, 0, 1);
  const partialFare = Math.round(originalFare * fraction);
  const refund = clamp(originalFare - partialFare, 0, originalFare);
  const finalDropSeq = dropSeq ?? bSeq;
  return { originalFare, partialFare, refund, dropStopSequence: finalDropSeq, dropStopName: nameOf(finalDropSeq) };
}

/** The customer id on a booking, whether or not `customer` is populated. */
function bookingCustomerId(booking: any): string {
  const c = booking.customer;
  return String(c && c._id ? c._id : c);
}

/**
 * POST /api/v1/drivers/journeys/early-drop/:bookingId/approve
 *
 * The driver approves a rider's pending early-drop request (from the Emergency
 * Alert screen). Recomputes the partial fare for the distance actually covered,
 * refunds the difference (wallet auto-credit; razorpay queued for support), and
 * records the drop. Idempotent + atomic so a double-tap can't double-refund.
 */
router.post('/early-drop/:bookingId/approve', async (req: AuthRequest, res: Response) => {
  try {
    const cleanId = String(req.params.bookingId).replace(/^sched_/, '');
    if (!mongoose.isValidObjectId(cleanId)) {
      res.status(400).json({ success: false, message: 'Invalid booking' });
      return;
    }
    const booking = await ScheduledBooking.findById(cleanId).populate(
      'customer',
      'firstName lastName phone',
    );
    if (!booking) {
      res.status(404).json({ success: false, message: 'Booking not found' });
      return;
    }
    if (String(booking.driver) !== String(req.user!._id)) {
      res.status(403).json({ success: false, message: 'This passenger is not on your vehicle' });
      return;
    }
    if (booking.earlyDrop?.status === 'approved') {
      res.json({ success: true, data: { earlyDrop: booking.earlyDrop, alreadyApproved: true } });
      return;
    }
    if (booking.earlyDrop?.status !== 'requested') {
      res.status(400).json({ success: false, message: 'No pending early-drop request for this passenger' });
      return;
    }
    if (booking.status !== 'reserved') {
      res.status(400).json({ success: false, message: 'This booking is not active' });
      return;
    }

    const routeDoc = await Route.findById(booking.route).lean();
    const driverUser = await User.findById(req.user!._id)
      .select('driverProfile.currentLocation')
      .lean();
    const driverLoc = (driverUser as any)?.driverProfile?.currentLocation ?? null;
    const journey = await DriverJourney.findOne({
      route: booking.route,
      driver: booking.driver,
      departureIndex: booking.departureIndex,
      departureDate: booking.departureDate,
    }).lean();

    const fare = computeEarlyDropFare(routeDoc, booking, driverLoc, journey);

    // Atomic claim — only the first approve while status is still 'requested'
    // wins, so the refund below runs exactly once.
    const claimed = await ScheduledBooking.findOneAndUpdate(
      { _id: booking._id, 'earlyDrop.status': 'requested' },
      {
        $set: {
          'earlyDrop.status': 'approved',
          'earlyDrop.decidedAt': new Date(),
          'earlyDrop.dropStopSequence': fare.dropStopSequence,
          'earlyDrop.originalFare': fare.originalFare,
          'earlyDrop.partialFare': fare.partialFare,
          'earlyDrop.refund': fare.refund,
        },
        $inc: { refundedAmount: fare.refund },
        $addToSet: { droppedSeats: { $each: booking.seats ?? [] } },
      },
      { new: true },
    );
    if (!claimed) {
      const fresh = await ScheduledBooking.findById(booking._id).lean();
      res.json({ success: true, data: { earlyDrop: fresh?.earlyDrop, alreadyApproved: true } });
      return;
    }

    const customerId = bookingCustomerId(booking);

    // Refund the unridden portion. Wallet is credited immediately; a card/UPI
    // (razorpay) payment is queued as a pending refund for support to push back
    // to the original method (matches the app's cancel-refund policy).
    if (fare.refund > 0) {
      if (booking.paymentMethod === 'wallet') {
        await Wallet.findOneAndUpdate(
          { user: customerId },
          { $inc: { balance: fare.refund } },
          { upsert: true },
        );
        await Payment.create({
          user: customerId,
          type: 'refund',
          amount: fare.refund,
          method: 'wallet',
          status: 'completed',
          description: `Early-drop refund — partial fare ₹${fare.partialFare} of ₹${fare.originalFare}`,
        }).catch((e) => console.warn('[early-drop] refund statement failed:', e));
      } else {
        await Payment.create({
          user: customerId,
          type: 'refund',
          amount: fare.refund,
          method: 'card',
          status: 'pending',
          description: `Early-drop refund (pending to original payment method) — partial fare ₹${fare.partialFare} of ₹${fare.originalFare}`,
        }).catch((e) => console.warn('[early-drop] pending refund failed:', e));
      }
    }

    const summary = {
      bookingId: String(booking._id),
      originalFare: fare.originalFare,
      partialFare: fare.partialFare,
      refund: fare.refund,
      refundMethod: booking.paymentMethod === 'wallet' ? 'wallet' : 'original',
      dropStopName: fare.dropStopName,
      droppedAt: new Date().toISOString(),
    };
    try {
      emitToUser(customerId, 'scheduled:early-drop-approved', summary);
    } catch { /* best-effort */ }
    try {
      const { sendPushToUser } = await import('../controllers/fcmController');
      const { templatedCopy } = await import('../services/notificationTemplate');
      const approvedCopy = await templatedCopy(
        'scheduled.early_drop_approved',
        { refund: fare.refund },
        {
          title: 'Early drop approved',
          body: fare.refund > 0
            ? `The driver will stop at the next safe point. ₹${fare.refund} will be refunded.`
            : 'The driver will stop at the next safe point.',
        },
      );
      await sendPushToUser(customerId, {
        title: approvedCopy.title,
        body: approvedCopy.body,
        data: { kind: 'scheduled:early-drop-approved', bookingId: String(booking._id) },
      });
    } catch { /* best-effort */ }

    res.json({ success: true, data: { earlyDrop: claimed.earlyDrop, ...summary } });
  } catch (err) {
    console.error('[early-drop approve] error:', err);
    res.status(500).json({ success: false, message: 'Failed to approve early drop' });
  }
});

/**
 * POST /api/v1/drivers/journeys/early-drop/:bookingId/decline
 * The driver can't safely stop — decline the request. The rider stays on to
 * their booked stop; no fare change.
 */
router.post('/early-drop/:bookingId/decline', async (req: AuthRequest, res: Response) => {
  try {
    const cleanId = String(req.params.bookingId).replace(/^sched_/, '');
    if (!mongoose.isValidObjectId(cleanId)) {
      res.status(400).json({ success: false, message: 'Invalid booking' });
      return;
    }
    const booking = await ScheduledBooking.findById(cleanId);
    if (!booking) {
      res.status(404).json({ success: false, message: 'Booking not found' });
      return;
    }
    if (String(booking.driver) !== String(req.user!._id)) {
      res.status(403).json({ success: false, message: 'This passenger is not on your vehicle' });
      return;
    }
    if (booking.earlyDrop?.status !== 'requested') {
      res.status(200).json({ success: true, data: { status: booking.earlyDrop?.status ?? null } });
      return;
    }
    const reason =
      typeof req.body?.reason === 'string' && req.body.reason.trim()
        ? req.body.reason.trim()
        : 'Not safe to stop here';
    booking.earlyDrop = {
      ...booking.earlyDrop,
      status: 'declined',
      reason,
      decidedAt: new Date(),
    };
    await booking.save();
    const customerId = bookingCustomerId(booking);
    try {
      emitToUser(customerId, 'scheduled:early-drop-declined', {
        bookingId: String(booking._id),
        reason,
      });
    } catch { /* best-effort */ }
    try {
      const { sendPushToUser } = await import('../controllers/fcmController');
      const { templatedCopy } = await import('../services/notificationTemplate');
      const declinedCopy = await templatedCopy(
        'scheduled.early_drop_declined',
        { reason },
        { title: 'Early drop not possible right now', body: reason },
      );
      await sendPushToUser(customerId, {
        title: declinedCopy.title,
        body: declinedCopy.body,
        data: { kind: 'scheduled:early-drop-declined', bookingId: String(booking._id) },
      });
    } catch { /* best-effort */ }
    res.json({ success: true, data: { status: 'declined', reason } });
  } catch (err) {
    console.error('[early-drop decline] error:', err);
    res.status(500).json({ success: false, message: 'Failed to decline early drop' });
  }
});

/**
 * GET /api/v1/drivers/journeys/early-drop/pending
 * Any early-drop requests currently awaiting THIS driver's approval. The app
 * calls this on resume so a request that arrived while backgrounded isn't lost.
 */
router.get('/early-drop/pending', async (req: AuthRequest, res: Response) => {
  try {
    const bookings = await ScheduledBooking.find({
      driver: req.user!._id,
      status: 'reserved',
      'earlyDrop.status': 'requested',
    })
      .populate('customer', 'firstName lastName phone')
      .lean();
    const requests = bookings.map((b: any) => ({
      bookingId: String(b._id),
      customerName:
        [b.customer?.firstName, b.customer?.lastName].filter(Boolean).join(' ') || 'Passenger',
      contact: b.customer?.phone ?? '',
      seats: b.seats ?? [],
      reason: b.earlyDrop?.reason ?? '',
      routeId: String(b.route),
      departureIndex: b.departureIndex,
      departureDate: b.departureDate,
      requestedAt: b.earlyDrop?.requestedAt ?? null,
    }));
    res.json({ success: true, data: { requests } });
  } catch (err) {
    console.error('[early-drop pending] error:', err);
    res.status(500).json({ success: false, message: 'Failed to load requests' });
  }
});

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

    // Only generate placeholder journeys for routes this driver is actually
    // registered on. The previous fallback to EVERY active scheduled route
    // meant a driver with no route registration saw journeys for all routes.
    const routesToCheck = myRoutes;

    const now = new Date();
    for (const r of routesToCheck) {
      const departures = r.schedule?.departures || [];
      const daysOfWeek = r.schedule?.daysOfWeek || [0, 1, 2, 3, 4, 5, 6];
      for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
        const instant = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
        // IST weekday + IST date — the route's daysOfWeek and the booking dates
        // are both IST-calendar values. Using server-local getDay()/UTC
        // toISOString() shifted everything a day during IST 00:00–05:30.
        const dayNum = istWeekday(instant);
        if (daysOfWeek.length > 0 && !daysOfWeek.includes(dayNum)) continue;
        const dateStr = istDateStrPlusDays(dayOffset, now);
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
      const dropped = new Set(b.droppedSeats ?? []);
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
          // Dropped early (got off before their booked stop) — no longer on board.
          dropped: dropped.has(seat),
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
        dropped: passengers.filter((p) => p.dropped).length,
        // Currently on the bus = boarded and not yet dropped off.
        onBoard: passengers.filter((p) => p.boarded && !p.dropped).length,
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
 *
 * Approval-gated: this is where a shuttle run *begins*. The check-in / drop /
 * complete endpoints below are intentionally left open so a driver rejected
 * mid-run can still finish the trip they already have passengers on.
 */
router.post('/:key/start', requireApprovedDriver, async (req: AuthRequest, res: Response) => {
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
  // Tell the rider their seat boarded so the onboarding hub advances to the
  // "You've Boarded Successfully!" stage in real time.
  try {
    const custId = cust && cust._id ? cust._id : booking.customer;
    emitToUser(String(custId), 'scheduled:boarded', {
      bookingId: String(booking._id),
      seats: booking.boardedSeats,
    });
  } catch { /* best-effort */ }
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

/** Record an EARLY DROP for seat(s) on a booking — the rider asked to get off
 *  before their booked stop. Unlike no-show, the seat STAYS boarded (they paid
 *  and rode), so settlement is unaffected; we only log it and notify the rider. */
async function earlyDropSeats(
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

  // Only boarded seats can be dropped early. Clamp to the booking's own seats.
  const boarded = new Set(booking.boardedSeats ?? []);
  const target = (seats && seats.length ? seats : booking.seats)
    .filter((s) => booking.seats.includes(s) && boarded.has(s));
  if (target.length === 0) {
    return { ok: false, message: 'That seat has not boarded yet' };
  }
  const set = new Set(booking.droppedSeats ?? []);
  target.forEach((s) => set.add(s));
  booking.droppedSeats = [...set].sort((a, b) => a - b);
  await booking.save();

  // Tell the rider their early drop was recorded.
  try {
    emitToUser(String(booking.customer && (booking.customer as any)._id ? (booking.customer as any)._id : booking.customer), 'scheduled:dropped', {
      bookingId: String(booking._id),
      seats: target,
    });
  } catch {
    /* best-effort */
  }

  const cust: any = booking.customer;
  return {
    ok: true,
    passenger: {
      bookingId: String(booking._id),
      name: [cust?.firstName, cust?.lastName].filter(Boolean).join(' ') || 'Passenger',
      seats: booking.seats,
      droppedSeats: booking.droppedSeats,
    },
  };
}

/**
 * POST /api/v1/drivers/journeys/:key/drop
 * Early drop: the rider asked to get off before their booked stop. Body:
 * { bookingId, seats? }. The seat stays boarded (still earns) — this only logs
 * the early drop and notifies the rider. Does NOT end the journey.
 */
router.post('/:key/drop', async (req: AuthRequest, res: Response) => {
  try {
    const parsed = parseKey(req.params.key);
    if (!parsed) {
      res.status(400).json({ success: false, message: 'Invalid journey' });
      return;
    }
    const { bookingId, seats } = req.body || {};
    const result = await earlyDropSeats(parsed, req.user!._id, bookingId, seats);
    if (!result.ok) {
      res.status(400).json({ success: false, message: result.message });
      return;
    }
    res.json({ success: true, data: { passenger: result.passenger } });
  } catch (err) {
    console.error('[Journey drop] error:', err);
    res.status(500).json({ success: false, message: 'Early drop failed' });
  }
});

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
    // The customer ticket QR carries { bookingId, ref, ... }; `ref` is the
    // 8-char short code (or bookingId) shown on the ticket, matched by boardSeats
    // even when it isn't a full ObjectId.
    if (typeof raw === 'string') {
      try {
        const obj = JSON.parse(raw);
        bookingId = obj?.bookingId || obj?.id || obj?.ref;
      } catch {
        bookingId = raw; // a bare bookingId string
      }
    } else if (raw && typeof raw === 'object') {
      bookingId = raw.bookingId || raw.id || raw.ref;
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

    // Gross = the paid amount attributable to boarded seats, MINUS anything
    // already refunded to the rider on an early drop (the driver shouldn't earn
    // on distance the rider got money back for). If a booking has no per-seat
    // split we prorate the net amount across its seats.
    let gross = 0;
    let boardedSeatCount = 0;
    for (const b of bookings) {
      const seats = b.seats?.length ?? 0;
      const boarded = (b.boardedSeats ?? []).length;
      boardedSeatCount += boarded;
      const net = Math.max(0, (b.totalAmount ?? 0) - (b.refundedAmount ?? 0));
      if (seats > 0 && net > 0) {
        gross += (net / seats) * boarded;
      }
    }
    gross = Math.round(gross * 100) / 100;

    // Driver share = gross minus platform commission.
    const settings = await Settings.findOne({ key: 'platform' }).select('commissionRate').lean();
    const commissionRate = settings?.commissionRate ?? config.ride.commissionRate ?? 0.2;
    const earnings = Math.round(gross * (1 - commissionRate) * 100) / 100;

    // Atomic completion claim — only the first concurrent /complete wins, so
    // the wallet credit + booking finalization below run exactly once. The
    // previous read-then-check-then-save let two concurrent completes both pass
    // the `status === 'completed'` guard above and both credit the wallet.
    const claimed = await DriverJourney.findOneAndUpdate(
      { _id: journey._id, status: { $ne: 'completed' } },
      { $set: { status: 'completed', completedAt: new Date(), earnings } },
      { new: true },
    );
    if (!claimed) {
      res.json({ success: true, data: { earnings: journey.earnings, alreadyCompleted: true } });
      return;
    }

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

/**
 * POST /api/v1/drivers/journeys/:key/rate-passengers
 * The driver rates the riders on their trip. Body:
 * { ratings: [{ bookingId, rating: 1..5, comment? }] }. Each rating is stored on
 * the matching booking (scoped to this driver's journey).
 */
router.post('/:key/rate-passengers', async (req: AuthRequest, res: Response) => {
  try {
    const parsed = parseKey(req.params.key);
    if (!parsed) {
      res.status(400).json({ success: false, message: 'Invalid journey' });
      return;
    }
    const ratings = Array.isArray(req.body?.ratings) ? req.body.ratings : [];
    if (ratings.length === 0) {
      res.status(400).json({ success: false, message: 'ratings array is required' });
      return;
    }
    let updated = 0;
    for (const r of ratings) {
      const bId = String(r?.bookingId || '');
      const val = Number(r?.rating);
      if (!mongoose.isValidObjectId(bId) || !(val >= 1 && val <= 5)) continue;
      const booking = await ScheduledBooking.findOne({
        _id: bId,
        route: parsed.routeId,
        driver: req.user!._id,
        departureIndex: parsed.index,
        departureDate: parsed.date,
      });
      if (!booking) continue;
      booking.driverToCustomerRating = Math.round(val);
      if (typeof r?.comment === 'string' && r.comment.trim()) {
        booking.driverComment = r.comment.trim();
      }
      await booking.save();
      updated++;
    }
    res.json({ success: true, data: { updated } });
  } catch (err) {
    console.error('[Journey rate-passengers] error:', err);
    res.status(500).json({ success: false, message: 'Failed to save ratings' });
  }
});

export default router;
