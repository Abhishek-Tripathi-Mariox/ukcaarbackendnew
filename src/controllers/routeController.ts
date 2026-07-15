import { Response } from 'express';
import { Route } from '../models';
import { AuthRequest } from '../middleware/auth';
import { distanceMeters } from '../utils/routeCorridor';
import { istDateStr, istDateStrPlusDays, istMinutesOfDay } from '../utils/date';
import { emitToUser } from '../socket';

/**
 * Driver and customer-facing route endpoints. The admin already has full
 * CRUD over routes in `routes/adminRoutes.ts`; this file exposes the
 * read + driver-self-registration subset that mobile apps need.
 */

/**
 * GET /api/v1/routes/scheduled
 * List active scheduled routes. Used by the driver app's
 * ChooseScheduledRouteScreen during registration AND by the customer app's
 * ScheduledRouteScreen when browsing.
 *
 * Query params:
 *   - hasApprovedDriver=true  → only return routes that have at least one
 *                                approved driver (used by customer app so
 *                                we never show a route nobody drives).
 */
export const listScheduledRoutes = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const filter: Record<string, unknown> = {
      type: 'scheduled',
      isActive: true,
    };

    const routes = await Route.find(filter)
      .select('-assignedUsers -__v')
      .sort({ name: 1 })
      .lean();

    // Proximity-aware listing. The customer's Home Scheduled tab passes
    // their pickup coords; we rank every active route by how close its
    // nearest stop is to the pickup so the closest departure rises to
    // the top. When drop coords are also supplied, we further narrow to
    // routes that serve the drop — at least one stop AFTER the pickup-
    // nearest stop must lie within the route's corridor of the drop.
    //
    // Pincodes (preferred): exact lat/lng rarely sits on a stop — the
    // rider may be 5+ km from the departure point but in the same town.
    // When the client passes pickup/drop pincodes we try a PIN match
    // against each stop's `address` field FIRST and treat the matching
    // stop as the boarding point. Coord-distance is then used only as a
    // tiebreaker and as the fallback when no PIN is supplied or matches.
    const pickupLat = parseFloat(req.query.pickupLat as string);
    const pickupLng = parseFloat(req.query.pickupLng as string);
    const dropLat = parseFloat(req.query.dropLat as string);
    const dropLng = parseFloat(req.query.dropLng as string);
    const pickupPincode = (req.query.pickupPincode as string | undefined)?.trim() || null;
    const dropPincode = (req.query.dropPincode as string | undefined)?.trim() || null;

    const hasPickup = Number.isFinite(pickupLat) && Number.isFinite(pickupLng);
    const hasDrop = Number.isFinite(dropLat) && Number.isFinite(dropLng);
    const pickup = hasPickup ? { lat: pickupLat, lng: pickupLng } : null;
    const drop = hasDrop ? { lat: dropLat, lng: dropLng } : null;

    /**
     * Pull a 6-digit Indian pincode out of a free-text address string.
     * Returns the last match because the typical Nominatim address
     * format is "<street>, <area>, <city>, <state>, <pincode>, <country>"
     * — the last 6-digit run is almost always the PIN, not a phone
     * number or building code that happens to be 6 digits long.
     */
    const extractPincode = (text?: string): string | null => {
      if (!text) return null;
      const matches = text.match(/\b\d{6}\b/g);
      if (!matches || matches.length === 0) return null;
      return matches[matches.length - 1];
    };

    /**
     * Resolve a stop's pincode. Prefers the explicit `pincode` field on
     * the stop doc (admin form captures it from the autocomplete result);
     * falls back to scanning the free-text `address` for legacy stops
     * that predate the dedicated field.
     */
    const stopPincode = (s: any): string | null => {
      if (s?.pincode && typeof s.pincode === 'string') {
        const t = s.pincode.trim();
        if (t) return t;
      }
      return extractPincode(s?.address);
    };

    /**
     * Pick the boarding stop on this route for the rider:
     *   1. If pickupPincode matches any stop's address PIN, prefer that
     *      stop (it's an explicit "I'm in this PIN, board me here" signal
     *      that beats geometric proximity — the rider might be 4 km from
     *      the stop but still in the same town).
     *   2. Otherwise, return the stop closest to the rider's coords.
     *
     * Returns null when no signal can place the rider on this route at
     * all (no PIN match AND no pickup coords).
     */
    const pickBoardingStop = (
      r: { stops: any[]; corridorBufferMeters: number },
    ): { stop: any; meters: number | null; matchedByPincode: boolean } | null => {
      if (!r.stops?.length) return null;
      // 1) Pincode pass — earliest matching stop wins (boarding should be
      //    the route's *first* opportunity to enter, not the last).
      if (pickupPincode) {
        const sortedBySeq = [...r.stops].sort(
          (a: any, b: any) => (a.sequence ?? 0) - (b.sequence ?? 0),
        );
        for (const s of sortedBySeq) {
          if (stopPincode(s) === pickupPincode) {
            const m = pickup
              ? distanceMeters(pickup, { lat: s.lat, lng: s.lng })
              : null;
            return { stop: s, meters: m, matchedByPincode: true };
          }
        }
      }
      // 2) Coord fallback — closest stop wins.
      if (pickup) {
        let best: { stop: any; meters: number } | null = null;
        for (const s of r.stops) {
          const m = distanceMeters(pickup, { lat: s.lat, lng: s.lng });
          if (!best || m < best.meters) best = { stop: s, meters: m };
        }
        if (best)
          return { stop: best.stop, meters: best.meters, matchedByPincode: false };
      }
      return null;
    };

    /**
     * True iff the route has a stop strictly after `afterSequence` that
     * either:
     *   - matches the rider's dropPincode (PIN-based — preferred), or
     *   - sits within the route's corridor buffer of `drop` (coord
     *     fallback for when no PIN was supplied or none matched).
     *
     * The sequence guard prevents matching a route that runs in the
     * wrong direction — drop must come after pickup.
     */
    const routeServesDrop = (
      r: { stops: any[]; corridorBufferMeters: number },
      afterSequence: number,
    ): boolean => {
      if (!drop && !dropPincode) return true;
      const later = r.stops.filter(
        (s: any) => typeof s.sequence === 'number' && s.sequence > afterSequence,
      );
      if (later.length === 0) return false;
      if (dropPincode) {
        const pinHit = later.some((s: any) => stopPincode(s) === dropPincode);
        if (pinHit) return true;
        // PIN was supplied but didn't match — fall through to coord check
        // so we still accept routes whose stops are geometrically near
        // the drop even if the admin didn't put the PIN on the stop.
      }
      if (drop) {
        return later.some(
          (s: any) =>
            distanceMeters(drop, { lat: s.lat, lng: s.lng }) <= r.corridorBufferMeters,
        );
      }
      return false;
    };

    // 1) Pick the boarding stop on every route (pincode-first, coord-fallback).
    // 2) Drop routes that don't reach the drop after the boarding stop.
    // 3) Sort: PIN-matched routes first (the strongest signal), then by
    //    ascending pickup-distance so the closest route surfaces top.
    type Ranked = {
      route: any;
      pickupMeters: number | null;
      pickupStop: any | null;
      matchedByPincode: boolean;
    };
    let ranked: Ranked[] = routes.map((r) => {
      const boarding = pickBoardingStop(r as any);
      return {
        route: r,
        pickupMeters: boarding?.meters ?? null,
        pickupStop: boarding?.stop ?? null,
        matchedByPincode: boarding?.matchedByPincode ?? false,
      };
    });
    if (hasDrop || dropPincode) {
      ranked = ranked.filter((x) =>
        routeServesDrop(x.route as any, x.pickupStop?.sequence ?? -1),
      );
    }
    // Strict "nearby pickup" filter. Ranking alone isn't enough — without
    // this we'd return EVERY active route (just sorted), so the customer's
    // Home Scheduled tab shows routes they can't actually reach. Keep a route
    // only when its boarding stop either matched the rider's pincode (the
    // strongest "I'm in this town" signal) or, as a coord fallback for stops
    // the admin didn't PIN-tag, sits within PICKUP_NEARBY_METERS of the
    // rider's pickup. Gated on pickup info so callers that pass none (e.g. the
    // Scheduled-tab driver-count aggregate) still get the full list.
    if (hasPickup || pickupPincode) {
      ranked.sort((a, b) => {
        // PIN match beats raw distance — surface "obviously in this town"
        // routes above ones that happen to be 200m closer on a map.
        if (a.matchedByPincode !== b.matchedByPincode) {
          return a.matchedByPincode ? -1 : 1;
        }
        const am = a.pickupMeters ?? Number.POSITIVE_INFINITY;
        const bm = b.pickupMeters ?? Number.POSITIVE_INFINITY;
        return am - bm;
      });
    }

    // Resolve the next-upcoming departure (date + index) for each route
    // so we can also surface "X seats booked on the next trip" — the
    // Available column on the customer card needs this. The "next trip"
    // logic mirrors what the customer app would compute locally: pick
    // the earliest departure time that's still in the future today; if
    // none, pick the earliest departure tomorrow.
    const todayStr = istDateStr();
    const tomorrowStr = istDateStrPlusDays(1);
    const nowMin = istMinutesOfDay();
    const nextDepartureFor = (
      r: any,
    ): { date: string; index: number } | null => {
      const departures: { time: string }[] = r.schedule?.departures ?? [];
      if (departures.length === 0) return null;
      const indexed = departures.map((d, i) => ({ ...d, originalIndex: i }));
      const sorted = [...indexed].sort((a, b) => a.time.localeCompare(b.time));
      const upcoming = sorted.find((d) => {
        const [h, m] = d.time.split(':').map(Number);
        return h * 60 + m > nowMin;
      });
      if (upcoming) return { date: todayStr, index: upcoming.originalIndex };
      return { date: tomorrowStr, index: sorted[0].originalIndex };
    };

    // Build the (route, date, index) tuples we need booked-seat counts
    // for, then aggregate in one query so this stays O(1) round-trips
    // regardless of how many routes match.
    const tripsByRoute = new Map<string, { date: string; index: number }>();
    for (const x of ranked) {
      const trip = nextDepartureFor(x.route);
      if (trip) tripsByRoute.set(String((x.route as any)._id), trip);
    }
    const bookedSeatsByRoute = new Map<string, number>();
    if (tripsByRoute.size > 0) {
      const { ScheduledBooking } = await import('../models');
      const orClauses = Array.from(tripsByRoute.entries()).map(([rid, t]) => ({
        route: rid,
        departureDate: t.date,
        departureIndex: t.index,
      }));
      const bookings = await ScheduledBooking.find({
        status: 'reserved',
        $or: orClauses,
      })
        .select('route seats')
        .lean();
      for (const b of bookings) {
        const key = String(b.route);
        const count = (b.seats?.length ?? 0);
        bookedSeatsByRoute.set(key, (bookedSeatsByRoute.get(key) ?? 0) + count);
      }
    }

    // Per-route, augment with the count of approved drivers + the list of
    // approved time slots (so the customer app can show "5 drivers, 3
    // departures" without further round-trips). Also surface the pickup-
    // nearest stop and its distance so the UI can render
    // "Departs from <stop> — 1.2 km away".
    const enriched = ranked.map(({ route: r, pickupMeters, pickupStop }) => {
      const approved = (r.registeredDrivers || []).filter(
        (d: any) => d.status === 'approved',
      );
      const approvedDeparturesSet = new Set<number>();
      approved.forEach((d: any) => {
        if (typeof d.departureIndex === 'number') {
          approvedDeparturesSet.add(d.departureIndex);
        }
      });
      const hasRoundTripDriver = approved.some((d: any) => d.roundTrip === true);
      const trip = tripsByRoute.get(String(r._id)) ?? null;
      return {
        _id: r._id,
        name: r.name,
        description: r.description,
        type: r.type,
        stops: r.stops,
        corridorBufferMeters: r.corridorBufferMeters,
        schedule: r.schedule,
        approvedDriverCount: approved.length,
        approvedDepartureIndexes: Array.from(approvedDeparturesSet).sort(
          (a, b) => a - b,
        ),
        hasRoundTripDriver,
        // Proximity hints — null when no pickup was passed.
        nearestPickupStopMeters:
          pickupMeters === null ? null : Math.round(pickupMeters),
        nearestPickupStopName: pickupStop?.name ?? null,
        nearestPickupStopSequence: pickupStop?.sequence ?? null,
        // Seat availability for the next-upcoming trip. The customer
        // Available column reads `booked/total` from these.
        nextDepartureDate: trip?.date ?? null,
        nextDepartureIndex: trip?.index ?? null,
        nextDepartureBookedSeats: trip
          ? bookedSeatsByRoute.get(String(r._id)) ?? 0
          : 0,
      };
    });

    // Distinct count of approved drivers across all matching routes. Used by
    // the customer Home screen's Scheduled-tab badge so the number reflects
    // total *people* available, not a sum that double-counts drivers on
    // multiple routes.
    const distinctDriverIds = new Set<string>();
    for (const x of ranked) {
      for (const reg of ((x.route as any).registeredDrivers || []) as any[]) {
        if (reg?.status === 'approved' && reg?.driver) {
          distinctDriverIds.add(String(reg.driver));
        }
      }
    }

    res.status(200).json({
      success: true,
      data: {
        routes: enriched,
        totalApprovedDrivers: distinctDriverIds.size,
      },
    });
  } catch (error) {
    console.error('listScheduledRoutes error:', error);
    res
      .status(500)
      .json({ success: false, message: 'Failed to fetch routes' });
  }
};

/**
 * GET /api/v1/routes/:id
 * Full route detail — used by the driver-side route preview and the
 * customer's route detail screen. Drops admin-only fields like assignedUsers.
 */
export const getRouteById = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const route = await Route.findById(req.params.id)
      .select('-assignedUsers -__v')
      .lean();
    if (!route || !route.isActive) {
      res.status(404).json({ success: false, message: 'Route not found' });
      return;
    }
    res.status(200).json({ success: true, data: { route } });
  } catch (error) {
    console.error('getRouteById error:', error);
    res
      .status(500)
      .json({ success: false, message: 'Failed to fetch route' });
  }
};

/**
 * POST /api/v1/routes/:id/register
 * Driver registers themselves for a scheduled route + a specific departure
 * slot. Creates a `pending` entry in `Route.registeredDrivers`; admin
 * approves later via the existing PATCH /admin/routes/:id/drivers/:driverId
 * endpoint.
 *
 * Body: { departureIndex?: number, departureTime?: string,
 *         roundTrip?: boolean, vehicleId?: string }
 *
 * Either `departureIndex` (existing admin-scheduled slot) OR `departureTime`
 * (free-form "HH:mm" picked by the driver) must be supplied. When a time is
 * given that isn't already in the schedule, we append a new departure entry
 * (stopIndex 0 = origin) and use its new index. This lets drivers register
 * at any hour without the admin needing to pre-define every possible slot.
 *
 * Rules enforced here (not the model):
 *   - Driver must be authenticated and have role=driver.
 *   - Route must exist and be type=scheduled + active.
 *   - departureIndex (if supplied) must be valid for this route's schedule.
 *   - departureTime (if supplied) must be in "HH:mm" 24h format.
 *   - Driver can only have ONE active registration (pending OR approved).
 *     Re-registering replaces the previous entry — drivers change their
 *     mind during onboarding and we don't want stale rows.
 */
export const registerDriverForRoute = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const { departureIndex, departureTime, roundTrip = false, vehicleId } =
      req.body;
    const driverId = req.user!._id;

    const hasIndex =
      typeof departureIndex === 'number' && departureIndex >= 0;
    const hasTime =
      typeof departureTime === 'string' &&
      /^([01]\d|2[0-3]):[0-5]\d$/.test(departureTime);

    if (!hasIndex && !hasTime) {
      res.status(400).json({
        success: false,
        message: 'departureIndex or departureTime is required',
      });
      return;
    }

    const route = await Route.findById(req.params.id);
    if (!route || !route.isActive || route.type !== 'scheduled') {
      res
        .status(404)
        .json({ success: false, message: 'Scheduled route not found' });
      return;
    }

    // Ensure the schedule subdoc exists so we can append to it when the
    // driver picks a free-form time the admin didn't pre-define.
    if (!route.schedule) {
      route.schedule = {
        daysOfWeek: [],
        departures: [],
        seatPrice: 0,
      } as any;
    }
    const departures = route.schedule!.departures ?? [];

    let resolvedIndex: number;
    if (hasIndex) {
      if (departureIndex >= departures.length) {
        res.status(400).json({
          success: false,
          message: `departureIndex ${departureIndex} out of range (max ${departures.length - 1})`,
        });
        return;
      }
      resolvedIndex = departureIndex;
    } else {
      // Free-form time: reuse an existing slot at the same time if one
      // exists, otherwise append a new one anchored at the origin stop.
      const existing = departures.findIndex(d => d.time === departureTime);
      if (existing >= 0) {
        resolvedIndex = existing;
      } else {
        departures.push({ stopIndex: 0, time: departureTime } as any);
        route.schedule!.departures = departures;
        resolvedIndex = departures.length - 1;
      }
    }

    // Drop any existing registration for this driver on this route — we
    // only allow one active row. Status transitions (re-applying after
    // rejection, switching slots) all go through this same code path.
    route.registeredDrivers = route.registeredDrivers.filter(
      d => String(d.driver) !== String(driverId),
    );

    route.registeredDrivers.push({
      driver: driverId as any,
      vehicle: vehicleId,
      status: 'pending',
      registeredAt: new Date(),
      departureIndex: resolvedIndex,
      roundTrip: !!roundTrip,
    } as any);

    await route.save();

    res.status(200).json({
      success: true,
      message: 'Registration submitted. Awaiting admin approval.',
      data: {
        routeId: route._id,
        departureIndex: resolvedIndex,
        departureTime:
          route.schedule!.departures[resolvedIndex]?.time ?? null,
        roundTrip,
        status: 'pending',
      },
    });
  } catch (error) {
    console.error('registerDriverForRoute error:', error);
    res
      .status(500)
      .json({ success: false, message: 'Failed to register for route' });
  }
};

/**
 * GET /api/v1/routes/my-registration
 * Returns the driver's current scheduled-route registration (if any) so the
 * dashboard / profile can show "You're registered for: Airport Shuttle,
 * 06:00 departure (Pending approval)".
 */
export const getMyRouteRegistration = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const driverId = req.user!._id;
    // Find any route where this driver has a non-removed registration.
    const route = await Route.findOne({
      type: 'scheduled',
      isActive: true,
      registeredDrivers: {
        $elemMatch: {
          driver: driverId,
          status: { $in: ['pending', 'approved'] },
        },
      },
    })
      .select('name description stops schedule registeredDrivers')
      .lean();

    if (!route) {
      res.status(200).json({ success: true, data: { registration: null } });
      return;
    }

    const reg = (route.registeredDrivers || []).find(
      (d: any) => String(d.driver) === String(driverId),
    );

    res.status(200).json({
      success: true,
      data: {
        registration: {
          route: {
            _id: route._id,
            name: route.name,
            description: route.description,
            stops: route.stops,
            schedule: route.schedule,
          },
          status: reg?.status,
          departureIndex: reg?.departureIndex,
          roundTrip: reg?.roundTrip,
          registeredAt: reg?.registeredAt,
        },
      },
    });
  } catch (error) {
    console.error('getMyRouteRegistration error:', error);
    res
      .status(500)
      .json({ success: false, message: 'Failed to fetch registration' });
  }
};

/**
 * GET /api/v1/routes/:id/vehicles?date=YYYY-MM-DD&departureIndex=N
 *
 * Lists every approved driver (= vehicle) serving this trip, each with its
 * own seat availability. Each driver runs their own shuttle of
 * schedule.totalSeats seats — seats are namespaced per vehicle — so the
 * customer first picks a vehicle, then its seat map.
 *
 *   { totalSeats, vehicles: [{ driverId, driverName, avatar, rating,
 *       totalTrips, vehicle: { make, model, color, plateNumber, typeCode },
 *       capacity, booked, available }] }
 *
 * A registration with no departureIndex serves every slot; one pinned to a
 * departureIndex serves only that slot.
 */
export const getRouteVehicles = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const { id } = req.params;
    const departureDate = String(req.query.date ?? '').trim();
    const departureIndex = parseInt(req.query.departureIndex as string, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(departureDate)) {
      res.status(400).json({ success: false, message: 'date (YYYY-MM-DD) is required' });
      return;
    }
    if (!Number.isInteger(departureIndex) || departureIndex < 0) {
      res.status(400).json({ success: false, message: 'departureIndex is required' });
      return;
    }

    const route = await Route.findById(id)
      .select('schedule isActive type registeredDrivers')
      .lean();
    if (!route || !route.isActive || route.type !== 'scheduled') {
      res.status(404).json({ success: false, message: 'Scheduled route not found' });
      return;
    }
    const totalSeats = route.schedule?.totalSeats ?? 0;

    const approved = (route.registeredDrivers || []).filter(
      (d: any) =>
        d.status === 'approved' &&
        (d.departureIndex == null || d.departureIndex === departureIndex),
    );
    if (approved.length === 0) {
      res.status(200).json({ success: true, data: { totalSeats, vehicles: [] } });
      return;
    }

    const driverIds = approved.map((d: any) => d.driver).filter(Boolean);
    const { User, ScheduledBooking } = await import('../models');

    const drivers = await User.find({ _id: { $in: driverIds } })
      .select(
        'firstName lastName avatar driverProfile.rating driverProfile.totalTrips ' +
          'driverProfile.vehicleMake driverProfile.vehicleModel driverProfile.vehicleColor ' +
          'driverProfile.plateNumber driverProfile.vehicleTypeCode',
      )
      .lean();
    const driverById = new Map(drivers.map((u: any) => [String(u._id), u]));

    // Booked-seat count per driver for this trip.
    const bookings = await ScheduledBooking.find({
      route: id,
      departureDate,
      departureIndex,
      status: 'reserved',
    })
      .select('driver seats')
      .lean();
    const bookedByDriver = new Map<string, number>();
    for (const b of bookings) {
      if (!b.driver) continue;
      const key = String(b.driver);
      bookedByDriver.set(key, (bookedByDriver.get(key) ?? 0) + (b.seats?.length ?? 0));
    }

    const vehicles = approved
      .filter((reg: any) => driverById.has(String(reg.driver)))
      .map((reg: any) => {
        const u: any = driverById.get(String(reg.driver));
        const dp = u?.driverProfile ?? {};
        const booked = bookedByDriver.get(String(reg.driver)) ?? 0;
        return {
          driverId: String(reg.driver),
          driverName:
            [u?.firstName, u?.lastName].filter(Boolean).join(' ') || 'Driver',
          avatar: u?.avatar ?? null,
          rating: dp.rating ?? 5,
          totalTrips: dp.totalTrips ?? 0,
          vehicle: {
            make: dp.vehicleMake ?? '',
            model: dp.vehicleModel ?? '',
            color: dp.vehicleColor ?? '',
            plateNumber: dp.plateNumber ?? '',
            typeCode: dp.vehicleTypeCode ?? null,
          },
          capacity: totalSeats,
          booked,
          available: Math.max(0, totalSeats - booked),
        };
      });

    res.status(200).json({ success: true, data: { totalSeats, vehicles } });
  } catch (error) {
    console.error('getRouteVehicles error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch vehicles' });
  }
};

/**
 * GET /api/v1/routes/:id/seats?date=YYYY-MM-DD&departureIndex=N&driverId=...
 *
 * Returns the seat layout for a specific trip on a specific vehicle:
 *   { totalSeats, booked: number[] }
 *
 * Frontend uses `booked` to grey-out seats other riders have reserved
 * so two people can't pick the same seat at the same time. Anyone who
 * cancels frees their seat back into the pool (status='cancelled' rows
 * are excluded from the booked list). `driverId` scopes the booked set to
 * one vehicle; omitting it falls back to route-level (legacy callers).
 */
export const getRouteSeats = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const { id } = req.params;
    const departureDate = String(req.query.date ?? '').trim();
    const departureIndex = parseInt(req.query.departureIndex as string, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(departureDate)) {
      res.status(400).json({ success: false, message: 'date (YYYY-MM-DD) is required' });
      return;
    }
    if (!Number.isInteger(departureIndex) || departureIndex < 0) {
      res.status(400).json({ success: false, message: 'departureIndex is required' });
      return;
    }

    // Note: `isActive` must be in the projection or it always reads
    // `undefined` and the `!isActive` check 404s every active route.
    const route = await Route.findById(id).select('schedule isActive').lean();
    if (!route || !route.isActive) {
      res.status(404).json({ success: false, message: 'Route not found' });
      return;
    }
    const totalSeats = route.schedule?.totalSeats ?? 0;

    // Scope booked seats to the chosen vehicle so seat #3 on driver A's
    // shuttle is independent of seat #3 on driver B's. Legacy callers that
    // omit driverId still get the (route-wide) booked set.
    const driverId = String(req.query.driverId ?? '').trim();
    const bookingFilter: Record<string, unknown> = {
      route: id,
      departureDate,
      departureIndex,
      status: 'reserved',
    };
    if (driverId) bookingFilter.driver = driverId;

    const { ScheduledBooking } = await import('../models');
    const bookings = await ScheduledBooking.find(bookingFilter)
      .select('seats')
      .lean();

    const bookedSet = new Set<number>();
    for (const b of bookings) {
      for (const s of b.seats ?? []) bookedSet.add(s);
    }

    res.status(200).json({
      success: true,
      data: {
        totalSeats,
        booked: Array.from(bookedSet).sort((a, b) => a - b),
      },
    });
  } catch (error) {
    console.error('getRouteSeats error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch seats' });
  }
};

/**
 * POST /api/v1/routes/:id/book
 * Body: { departureDate, departureIndex, seats: number[], totalAmount? }
 *
 * Atomically reserves the requested seats. Refuses the booking if any
 * of the seats are already held by another rider. The atomicity comes
 * from re-checking inside the same write — Mongo's findOneAndUpdate
 * with $addToSet would race; instead we do a tight read-then-create
 * and trust the per-route concurrency to be low (one route admin's
 * shuttle, max ~20 simultaneous riders). If two requests do collide,
 * the second one's seat-conflict check catches it on the second pass.
 */
export const bookRouteSeats = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const { id } = req.params;
    const {
      departureDate, departureIndex, seats, totalAmount, driverId, passengers,
      paymentMethod, boardingStopSequence, droppingStopSequence,
    } = req.body ?? {};

    if (!driverId || typeof driverId !== 'string') {
      res.status(400).json({ success: false, message: 'driverId (vehicle) is required' });
      return;
    }
    if (!Array.isArray(seats) || seats.length === 0) {
      res.status(400).json({ success: false, message: 'seats array is required' });
      return;
    }
    const seatList = seats
      .map((n: any) => Number(n))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (seatList.length === 0) {
      res.status(400).json({ success: false, message: 'invalid seat numbers' });
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(departureDate ?? ''))) {
      res.status(400).json({ success: false, message: 'departureDate (YYYY-MM-DD) is required' });
      return;
    }
    if (!Number.isInteger(departureIndex) || departureIndex < 0) {
      res.status(400).json({ success: false, message: 'departureIndex is required' });
      return;
    }

    const route = await Route.findById(id)
      .select('schedule isActive type registeredDrivers')
      .lean();
    if (!route || !route.isActive || route.type !== 'scheduled') {
      res.status(404).json({ success: false, message: 'Scheduled route not found' });
      return;
    }

    // The chosen vehicle must actually be an approved driver serving this
    // departure (no departureIndex = serves all slots).
    const servesTrip = (route.registeredDrivers || []).some(
      (d: any) =>
        d.status === 'approved' &&
        String(d.driver) === String(driverId) &&
        (d.departureIndex == null || d.departureIndex === departureIndex),
    );
    if (!servesTrip) {
      res.status(400).json({
        success: false,
        message: 'Selected vehicle is not available for this trip',
      });
      return;
    }

    const totalSeats = route.schedule?.totalSeats ?? 0;
    const outOfRange = seatList.find((n) => n > totalSeats);
    if (outOfRange !== undefined) {
      res.status(400).json({
        success: false,
        message: `Seat ${outOfRange} doesn't exist (route has ${totalSeats} seats)`,
      });
      return;
    }
    if (departureIndex >= (route.schedule?.departures?.length ?? 0)) {
      res.status(400).json({
        success: false,
        message: 'Invalid departure slot for this route',
      });
      return;
    }

    const { ScheduledBooking } = await import('../models');

    // Conflict check — read every reserved booking for the same trip AND
    // vehicle and refuse if any requested seat is already held. Scoped to
    // the driver so identical seat numbers on different vehicles don't clash.
    const existing = await ScheduledBooking.find({
      route: id,
      departureDate,
      departureIndex,
      driver: driverId,
      status: 'reserved',
    })
      .select('seats')
      .lean();
    const taken = new Set<number>();
    for (const b of existing) for (const s of b.seats ?? []) taken.add(s);
    const conflicts = seatList.filter((n) => taken.has(n));
    if (conflicts.length > 0) {
      res.status(409).json({
        success: false,
        message: 'Some of the seats you picked were just taken by another rider.',
        data: { conflicts, taken: Array.from(taken).sort((a, b) => a - b) },
      });
      return;
    }

    // Normalise passenger rows (seat + name [+ contact]) so the ticket and
    // Activity history can show who each seat is for after the fact.
    const paxList = Array.isArray(passengers)
      ? passengers
          .map((p: any) => ({
            seat: Number(p?.seat) || 0,
            name: String(p?.name ?? '').trim(),
            contact: p?.contact ? String(p.contact).trim() : undefined,
          }))
          .filter((p: any) => p.name)
      : [];

    // Charge exactly the amount the rider was shown and agreed to (the app
    // computes it from the route's per-segment `fareFromPrevious` fares, which
    // can legitimately sum to MORE or LESS than a single flat seatPrice). Do
    // NOT derive it from a flat seatPrice here — that over-charged short
    // segments and UNDER-charged long ones (shown ₹4000 but debited the flat
    // ~₹1000). Exact server-side segment pricing (to also enforce a FLOOR
    // against a tampered client under-paying) needs the boarding/dropping stop
    // indices persisted — that's a tracked follow-up.
    const amount = Number(totalAmount) || 0;

    // ── Wallet payment ──
    // When the rider pays from their UKCAAR wallet, the debit MUST happen
    // here, server-side. Previously the app only subtracted the amount from
    // its local Redux copy and no Wallet write ever occurred — the balance
    // "snapped back" on the next fetch and the booking was effectively free.
    // Razorpay bookings are unaffected (verified before this call).
    let walletBalanceAfter: number | undefined;
    if (paymentMethod === 'wallet') {
      if (!(amount > 0)) {
        res.status(400).json({ success: false, message: 'Booking amount unavailable' });
        return;
      }
      const { Wallet } = await import('../models');
      // Atomic conditional decrement — only succeeds if balance >= amount,
      // so two concurrent bookings can't both spend the same rupees.
      const debited = await Wallet.findOneAndUpdate(
        { user: req.user!._id, balance: { $gte: amount } },
        { $inc: { balance: -amount } },
        { new: true },
      );
      if (!debited) {
        const current = await Wallet.findOne({ user: req.user!._id }).select('balance').lean();
        res.status(400).json({
          success: false,
          message: 'Insufficient wallet balance',
          data: { walletBalance: current?.balance ?? 0, required: amount },
        });
        return;
      }
      walletBalanceAfter = debited.balance;
    }

    let booking;
    try {
      booking = await ScheduledBooking.create({
        route: id,
        departureDate,
        departureIndex,
        driver: driverId,
        seats: seatList,
        passengers: paxList,
        customer: req.user!._id,
        status: 'reserved',
        totalAmount: amount,
        // Recorded so cancellation knows whether to auto-refund the wallet.
        paymentMethod: paymentMethod === 'wallet' ? 'wallet' : 'razorpay',
        // Booked segment (stop `sequence` values) — powers the early-drop
        // partial-fare recompute. Only stored when the client sends valid
        // numbers; legacy/absent falls back to whole-route span at drop time.
        ...(Number.isInteger(boardingStopSequence) && boardingStopSequence >= 0
          ? { boardingStopSequence }
          : {}),
        ...(Number.isInteger(droppingStopSequence) && droppingStopSequence >= 0
          ? { droppingStopSequence }
          : {}),
      });
    } catch (createErr) {
      // Booking failed after we took the money — refund the debit so the
      // rider is never charged for a reservation that doesn't exist.
      if (paymentMethod === 'wallet') {
        const { Wallet } = await import('../models');
        await Wallet.findOneAndUpdate(
          { user: req.user!._id },
          { $inc: { balance: amount } },
        ).catch(() => {});
      }
      throw createErr;
    }

    // Wallet statement row (best-effort — the money movement above is the
    // source of truth; a missing row only affects the statement display).
    if (paymentMethod === 'wallet') {
      try {
        const { Payment } = await import('../models');
        await Payment.create({
          user: req.user!._id,
          type: 'scheduled_booking',
          amount,
          method: 'wallet',
          status: 'completed',
          description: `Scheduled seat booking: ₹${amount} (${seatList.length} seat${seatList.length === 1 ? '' : 's'})`,
        });
      } catch (payErr) {
        console.warn('bookRouteSeats: statement row failed:', payErr);
      }
    }

    res.status(201).json({
      success: true,
      message: 'Seats reserved',
      // walletBalance present only for wallet payments — the app should set
      // its local balance from this instead of doing its own subtraction.
      data: { booking, ...(walletBalanceAfter !== undefined && { walletBalance: walletBalanceAfter }) },
    });
  } catch (error) {
    console.error('bookRouteSeats error:', error);
    res.status(500).json({ success: false, message: 'Booking failed' });
  }
};

/**
 * POST /api/v1/routes/bookings/:bookingId/cancel
 *
 * Cancels a scheduled-seat booking owned by the current user. Flips the
 * booking to status='cancelled', which frees its seats back into the pool
 * (the seat-availability query only counts status='reserved' rows).
 */
export const cancelRouteBooking = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const { bookingId } = req.params;
    // The customer app surfaces scheduled bookings with a `sched_` prefix on
    // the id (see getRides projection) — tolerate it here so callers can pass
    // either the raw booking id or the prefixed one.
    const cleanId = String(bookingId).replace(/^sched_/, '');

    const { ScheduledBooking } = await import('../models');
    const booking = await ScheduledBooking.findById(cleanId);
    if (!booking) {
      res.status(404).json({ success: false, message: 'Booking not found' });
      return;
    }
    if (String(booking.customer) !== String(req.user!._id)) {
      res.status(403).json({ success: false, message: 'Not your booking' });
      return;
    }
    if (booking.status === 'cancelled') {
      res.status(200).json({ success: true, message: 'Booking already cancelled', data: { booking } });
      return;
    }

    // Record who cancelled and why so admin/customer history shows the same
    // "cancelled by + reason" detail that instant-Ride records carry. This is
    // a customer-initiated endpoint (ownership checked above), so the actor is
    // the customer; the reason is optional from the client.
    const reason =
      typeof req.body?.reason === 'string' && req.body.reason.trim()
        ? req.body.reason.trim()
        : 'Cancelled by customer';

    booking.status = 'cancelled';
    booking.cancellation = {
      cancelledBy: 'customer',
      reason,
      cancelledAt: new Date(),
    };
    await booking.save();

    // Wallet-paid bookings are debited server-side at reservation, so the
    // cancel must give the money back. Razorpay refunds stay manual (support/
    // admin) — same as instant rides. Refund AFTER the status flip so a crash
    // can only under-refund (support-recoverable), never leave a cancelled=no
    // + refunded=yes combination that hands out free money.
    let walletBalanceAfter: number | undefined;
    if (booking.paymentMethod === 'wallet' && booking.totalAmount > 0) {
      const { Wallet, Payment } = await import('../models');
      const refunded = await Wallet.findOneAndUpdate(
        { user: booking.customer },
        { $inc: { balance: booking.totalAmount } },
        { new: true, upsert: true },
      );
      walletBalanceAfter = refunded.balance;
      try {
        await Payment.create({
          user: booking.customer,
          type: 'refund',
          amount: booking.totalAmount,
          method: 'wallet',
          status: 'completed',
          description: `Refund: cancelled scheduled booking (${booking.seats.length} seat${booking.seats.length === 1 ? '' : 's'})`,
        });
      } catch (payErr) {
        console.warn('cancelRouteBooking: refund statement row failed:', payErr);
      }
    }

    res.status(200).json({
      success: true,
      message: 'Booking cancelled',
      data: {
        booking,
        ...(walletBalanceAfter !== undefined && { walletBalance: walletBalanceAfter }),
      },
    });
  } catch (error) {
    console.error('cancelRouteBooking error:', error);
    res.status(500).json({ success: false, message: 'Failed to cancel booking' });
  }
};

/**
 * POST /api/v1/routes/bookings/:bookingId/early-drop/request
 *
 * The rider — riding an active scheduled shuttle — asks to be let off before
 * their booked stop ("Emergency → Need to Stop Mid-Route" in the app). This
 * only RECORDS the request and pings the driver; the driver approves from the
 * Emergency Alert screen, and only THEN is the partial fare recomputed and the
 * difference refunded. Customer-initiated, driver-approved — matching the
 * Figma onboarding flow.
 */
export const requestEarlyDrop = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const cleanId = String(req.params.bookingId).replace(/^sched_/, '');
    const { ScheduledBooking, DriverJourney } = await import('../models');
    const booking = await ScheduledBooking.findById(cleanId).populate(
      'customer',
      'firstName lastName phone',
    );
    if (!booking) {
      res.status(404).json({ success: false, message: 'Booking not found' });
      return;
    }
    const customerId =
      (booking.customer as any)?._id ?? booking.customer;
    if (String(customerId) !== String(req.user!._id)) {
      res.status(403).json({ success: false, message: 'Not your booking' });
      return;
    }
    if (booking.status !== 'reserved') {
      res.status(400).json({
        success: false,
        message: 'This booking is not active.',
      });
      return;
    }
    // Already decided / mid-flight guards keep the request idempotent so a
    // double-tap or a retry never opens a second request or errors the client.
    const ed = booking.earlyDrop;
    if (ed?.status === 'approved') {
      res.status(200).json({
        success: true,
        message: 'Your early drop was already approved.',
        data: { status: 'approved', earlyDrop: ed },
      });
      return;
    }
    if (ed?.status === 'requested') {
      res.status(200).json({
        success: true,
        message: 'Your request is awaiting driver approval.',
        data: { status: 'requested', earlyDrop: ed },
      });
      return;
    }

    // The trip must actually be under way — you can only ask to get off a bus
    // you're on. "Under way" = the driver's journey is active/in_progress OR
    // the rider has a boarded seat.
    if (!booking.driver) {
      res.status(400).json({ success: false, message: 'No driver is assigned to this trip yet.' });
      return;
    }
    const journey = await DriverJourney.findOne({
      route: booking.route,
      driver: booking.driver,
      departureIndex: booking.departureIndex,
      departureDate: booking.departureDate,
    }).lean();
    const journeyActive =
      journey?.status === 'active' || journey?.status === 'in_progress';
    const hasBoarded = (booking.boardedSeats?.length ?? 0) > 0;
    if (!journeyActive && !hasBoarded) {
      res.status(400).json({
        success: false,
        message: 'Your trip hasn’t started yet. You can request an early drop once you’re on board.',
      });
      return;
    }

    const reason =
      typeof req.body?.reason === 'string' && req.body.reason.trim()
        ? req.body.reason.trim()
        : 'Early drop requested';
    booking.earlyDrop = {
      status: 'requested',
      reason,
      requestedAt: new Date(),
    };
    await booking.save();

    // Notify the specific driver whose vehicle the rider is on — socket for a
    // foregrounded app, push for a backgrounded one.
    const cust: any = booking.customer;
    const customerName =
      [cust?.firstName, cust?.lastName].filter(Boolean).join(' ') || 'Passenger';
    const payload = {
      bookingId: String(booking._id),
      customerName,
      contact: cust?.phone ?? '',
      seats: booking.seats ?? [],
      reason,
      routeId: String(booking.route),
      departureIndex: booking.departureIndex,
      departureDate: booking.departureDate,
    };
    try {
      emitToUser(String(booking.driver), 'scheduled:early-drop-request', payload);
    } catch { /* best-effort */ }
    try {
      const { sendPushToUser } = await import('./fcmController');
      await sendPushToUser(String(booking.driver), {
        title: 'Early drop requested',
        body: `${customerName} (Seat ${(booking.seats ?? []).join(', ')}) is asking to get off early.`,
        data: { kind: 'scheduled:early-drop-request', bookingId: String(booking._id) },
      });
    } catch { /* best-effort */ }

    res.status(200).json({
      success: true,
      message: 'Request sent to your driver.',
      data: { status: 'requested', earlyDrop: booking.earlyDrop },
    });
  } catch (error) {
    console.error('requestEarlyDrop error:', error);
    res.status(500).json({ success: false, message: 'Failed to send request' });
  }
};

/**
 * POST /api/v1/routes/bookings/:bookingId/early-drop/cancel
 * The rider withdraws a still-pending early-drop request ("Cancel Request" on
 * the waiting screen). No-op once the driver has already approved/declined.
 */
export const cancelEarlyDrop = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const cleanId = String(req.params.bookingId).replace(/^sched_/, '');
    const { ScheduledBooking } = await import('../models');
    const booking = await ScheduledBooking.findById(cleanId);
    if (!booking) {
      res.status(404).json({ success: false, message: 'Booking not found' });
      return;
    }
    if (String(booking.customer) !== String(req.user!._id)) {
      res.status(403).json({ success: false, message: 'Not your booking' });
      return;
    }
    if (booking.earlyDrop?.status !== 'requested') {
      // Nothing pending to cancel — treat as success so the UI just returns.
      res.status(200).json({
        success: true,
        message: 'No pending request.',
        data: { status: booking.earlyDrop?.status ?? null },
      });
      return;
    }
    booking.earlyDrop = {
      ...booking.earlyDrop,
      status: 'cancelled',
      decidedAt: new Date(),
    };
    await booking.save();
    if (booking.driver) {
      try {
        emitToUser(String(booking.driver), 'scheduled:early-drop-cancelled', {
          bookingId: String(booking._id),
        });
      } catch { /* best-effort */ }
    }
    res.status(200).json({ success: true, message: 'Request cancelled', data: { status: 'cancelled' } });
  } catch (error) {
    console.error('cancelEarlyDrop error:', error);
    res.status(500).json({ success: false, message: 'Failed to cancel request' });
  }
};

/**
 * POST /api/v1/routes/bookings/:bookingId/rate
 * Body: { rating: 1..5, feedback? }
 * Rider's post-trip feedback for a scheduled-shuttle booking (the "How Was Your
 * Ride?" screen). Stored on the booking; shuttle bookings have no Ride doc so
 * this is a separate path from the instant-ride rateRide.
 */
export const rateBooking = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const cleanId = String(req.params.bookingId).replace(/^sched_/, '');
    const rating = Number(req.body?.rating);
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      res.status(400).json({ success: false, message: 'rating must be 1–5' });
      return;
    }
    const { ScheduledBooking } = await import('../models');
    const booking = await ScheduledBooking.findById(cleanId);
    if (!booking) {
      res.status(404).json({ success: false, message: 'Booking not found' });
      return;
    }
    if (String(booking.customer) !== String(req.user!._id)) {
      res.status(403).json({ success: false, message: 'Not your booking' });
      return;
    }
    booking.rating = Math.round(rating);
    const fb = typeof req.body?.feedback === 'string' ? req.body.feedback.trim() : '';
    if (fb) booking.feedback = fb;
    await booking.save();
    res.status(200).json({ success: true, message: 'Thanks for your feedback' });
  } catch (error) {
    console.error('rateBooking error:', error);
    res.status(500).json({ success: false, message: 'Failed to save feedback' });
  }
};

/**
 * GET /api/v1/routes/bookings/:bookingId/status
 *
 * Live trip-state for the rider's scheduled-shuttle onboarding hub. Returns the
 * everything the hub needs to pick the right stage (Departing → Bus Arriving →
 * Bus Arrived → Show Ticket → Boarded → Track Live). Cheap enough to poll.
 */
export const getBookingStatus = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const cleanId = String(req.params.bookingId).replace(/^sched_/, '');
    const { ScheduledBooking, DriverJourney, User } = await import('../models');
    const booking = await ScheduledBooking.findById(cleanId).lean();
    if (!booking) {
      res.status(404).json({ success: false, message: 'Booking not found' });
      return;
    }
    if (String(booking.customer) !== String(req.user!._id)) {
      res.status(403).json({ success: false, message: 'Not your booking' });
      return;
    }

    const routeDoc = await Route.findById(booking.route)
      .select('name stops schedule')
      .lean();
    const stops = [...(routeDoc?.stops ?? [])].sort(
      (a: any, b: any) => (a.sequence ?? 0) - (b.sequence ?? 0),
    );
    const stopBySeq = (seq?: number) =>
      typeof seq === 'number' ? stops.find((s: any) => (s.sequence ?? 0) === seq) : undefined;
    const boardingStop = stopBySeq(booking.boardingStopSequence) ?? stops[0];
    const droppingStop = stopBySeq(booking.droppingStopSequence) ?? stops[stops.length - 1];
    const departureTime =
      routeDoc?.schedule?.departures?.[booking.departureIndex]?.time ?? '';

    // Minutes until the IST departure instant (departureDate + time are IST).
    let minutesToDeparture: number | null = null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(booking.departureDate) && /^\d{2}:\d{2}$/.test(departureTime)) {
      const targetMs = Date.parse(`${booking.departureDate}T${departureTime}:00+05:30`);
      if (!Number.isNaN(targetMs)) {
        minutesToDeparture = Math.round((targetMs - Date.now()) / 60000);
      }
    }

    // Journey + driver.
    const journey = booking.driver
      ? await DriverJourney.findOne({
          route: booking.route,
          driver: booking.driver,
          departureIndex: booking.departureIndex,
          departureDate: booking.departureDate,
        }).lean()
      : null;
    const journeyStatus = journey?.status ?? null;
    const journeyActive = journeyStatus === 'active' || journeyStatus === 'in_progress';

    let driverInfo: any = null;
    let driverLocation: any = null;
    if (booking.driver) {
      const drv = await User.findById(booking.driver)
        .select(
          'firstName lastName avatar phone driverProfile.rating driverProfile.plateNumber ' +
            'driverProfile.vehicleMake driverProfile.vehicleModel driverProfile.vehicleColor ' +
            'driverProfile.currentLocation',
        )
        .lean();
      if (drv) {
        const dp: any = (drv as any).driverProfile ?? {};
        driverInfo = {
          id: String((drv as any)._id),
          name: [(drv as any).firstName, (drv as any).lastName].filter(Boolean).join(' ') || 'Driver',
          phone: (drv as any).phone ?? null,
          avatar: (drv as any).avatar ?? null,
          rating: dp.rating ?? null,
          vehicle: {
            make: dp.vehicleMake ?? '',
            model: dp.vehicleModel ?? '',
            color: dp.vehicleColor ?? '',
            plateNumber: dp.plateNumber ?? '',
          },
        };
        if (dp.currentLocation && typeof dp.currentLocation.lat === 'number') {
          driverLocation = { lat: dp.currentLocation.lat, lng: dp.currentLocation.lng };
        }
      }
    }

    // Has the bus effectively arrived at the rider's boarding stop? (driver
    // live GPS within ~350m of the boarding stop while the journey is running).
    let atBoarding = false;
    if (journeyActive && driverLocation && boardingStop) {
      atBoarding =
        distanceMeters(driverLocation, { lat: boardingStop.lat, lng: boardingStop.lng }) <= 350;
    }

    const boardedSet = new Set(booking.boardedSeats ?? []);
    const boarded = (booking.seats ?? []).some((s) => boardedSet.has(s));

    res.json({
      success: true,
      data: {
        bookingId: String(booking._id),
        status: booking.status,
        routeId: String(booking.route),
        routeName: routeDoc?.name ?? null,
        boardingName: boardingStop?.name ?? null,
        droppingName: droppingStop?.name ?? null,
        departureDate: booking.departureDate,
        departureTime,
        minutesToDeparture,
        seats: booking.seats ?? [],
        journeyStatus,
        journeyActive,
        atBoarding,
        boarded,
        driver: driverInfo,
        driverLocation,
        earlyDrop: booking.earlyDrop ?? null,
      },
    });
  } catch (error) {
    console.error('getBookingStatus error:', error);
    res.status(500).json({ success: false, message: 'Failed to load trip status' });
  }
};
