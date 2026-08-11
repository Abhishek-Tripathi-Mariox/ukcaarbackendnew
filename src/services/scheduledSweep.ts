import { ScheduledBooking, DriverJourney, Wallet, Payment } from '../models';
import { istDateStr, istDateStrPlusDays } from '../utils/date';

/**
 * Expiry sweep for the scheduled-shuttle system.
 *
 * Before this existed, a 'reserved' booking whose departure date passed
 * without the trip ever running just lived forever — holding the customer's
 * money with no path to a refund, and its DriverJourney sat 'scheduled'
 * indefinitely. This sweep (run hourly from startRideMaintenance):
 *
 *   1. Flips stale reserved bookings to the terminal 'expired' status and
 *      refunds the unridden amount. WALLET bookings only are auto-credited
 *      (their debit happened server-side at reservation, so the credit is
 *      provably returning our own money). Non-wallet bookings get a PENDING
 *      Payment refund row for support to settle after verifying the charge —
 *      bookRouteSeats never verifies razorpay payments (totalAmount is
 *      client-supplied), so auto-crediting them would let fabricated
 *      bookings mint real wallet money.
 *   2. Marks never-started DriverJourney rows for past dates as 'expired'.
 *   3. Expires started-but-abandoned journeys (active/in_progress two full
 *      IST days past their departure date) so their riders' money stops
 *      being frozen: boarded bookings settle as 'completed' (they rode);
 *      unboarded ones become refundable by pass 1 on the next run.
 *
 * A booking is only expired when its journey never ran: if the driver's
 * journey is active / in_progress / completed, the driver may still
 * legitimately settle it, so the sweep leaves it alone. Boarded bookings are
 * excluded outright — the rider rode, that money is not refundable here.
 */

/** Cap per run so one sweep can't stall the maintenance interval. */
const BOOKING_BATCH_LIMIT = 200;

export async function sweepExpiredScheduled(): Promise<{
  bookingsExpired: number;
  journeysExpired: number;
}> {
  const today = istDateStr();

  // ── 1) Expire + refund stale reserved bookings ──
  const stale = await ScheduledBooking.find({
    status: 'reserved',
    departureDate: { $lt: today },
    // Never touch a booking with boarded seats — the rider actually rode.
    // $size:0 doesn't match a missing array, hence the $or.
    $or: [{ boardedSeats: { $exists: false } }, { boardedSeats: { $size: 0 } }],
  })
    .limit(BOOKING_BATCH_LIMIT)
    .lean();

  let bookingsExpired = 0;
  let refundedTotal = 0;

  for (const b of stale) {
    try {
      // If the driver's journey for this trip ran (or is running), the trip
      // isn't dead — completion/settlement handles it. Skip. INVARIANT: the
      // skip list must NOT contain 'expired' — pass 3 below relies on this
      // pass refunding the unboarded bookings of abandoned journeys it
      // expires.
      if (b.driver) {
        const journey = await DriverJourney.findOne({
          route: b.route,
          driver: b.driver,
          departureIndex: b.departureIndex,
          departureDate: b.departureDate,
        })
          .select('status')
          .lean();
        if (
          journey &&
          ['active', 'in_progress', 'completed'].includes(journey.status)
        ) {
          continue;
        }
      }

      // Atomic claim — only the run that flips reserved→expired performs the
      // refund, so an overlapping sweep can never double-credit. Status flips
      // BEFORE money moves: a crash mid-way under-refunds (support-
      // recoverable) rather than refunding a still-live booking.
      const claimed = await ScheduledBooking.findOneAndUpdate(
        { _id: b._id, status: 'reserved' },
        { $set: { status: 'expired' } },
        { new: true },
      );
      if (!claimed) continue;
      bookingsExpired += 1;

      // Refund whatever the rider hasn't already been given back (early
      // drops may have partially refunded this booking).
      const refund = Math.max(
        0,
        (claimed.totalAmount ?? 0) - (claimed.refundedAmount ?? 0),
      );
      if (refund > 0 && claimed.paymentMethod === 'wallet') {
        // Wallet bookings were debited server-side at reservation — this
        // credit provably returns our own debit, so it is safe to automate.
        await Wallet.findOneAndUpdate(
          { user: claimed.customer },
          { $inc: { balance: refund } },
          { upsert: true },
        );
        await ScheduledBooking.updateOne(
          { _id: claimed._id },
          { $set: { refundedAmount: claimed.totalAmount ?? 0 } },
        );
        refundedTotal += refund;
        // Statement row (best-effort — the wallet credit above is the source
        // of truth; a missing row only affects the statement display).
        await Payment.create({
          user: claimed.customer,
          type: 'refund',
          amount: refund,
          method: 'wallet',
          status: 'completed',
          description: `Refund: scheduled trip on ${claimed.departureDate} did not run`,
        }).catch((e) =>
          console.warn('[scheduled sweep] refund statement row failed:', e),
        );

        // Tell the rider their money came back. Same helper the early-drop
        // refund uses; template-overridable, hardcoded fallback.
        try {
          const { sendPushToUser } = await import('../controllers/fcmController');
          const { templatedCopy } = await import('./notificationTemplate');
          const copy = await templatedCopy(
            'scheduled.trip_expired_refund',
            { date: claimed.departureDate, amount: refund },
            {
              title: 'Trip refunded',
              body: `Your scheduled trip on ${claimed.departureDate} did not run. INR ${refund} has been refunded to your wallet.`,
            },
          );
          await sendPushToUser(String(claimed.customer), {
            title: copy.title,
            body: copy.body,
            data: {
              kind: 'scheduled:expired-refund',
              bookingId: String(claimed._id),
            },
          });
        } catch {
          /* best-effort */
        }
      } else if (refund > 0) {
        // Non-wallet (razorpay, or legacy rows with no recorded method): the
        // charge was never verified server-side, so NO automatic wallet
        // credit — a fabricated razorpay booking would otherwise mint real
        // money here. Queue a pending refund row (field-for-field the same
        // shape as the early-drop razorpay branch) for support to settle
        // manually after verifying the actual charge. refundedAmount is left
        // untouched until the money actually moves.
        await Payment.create({
          user: claimed.customer,
          type: 'refund',
          amount: refund,
          method: 'card',
          status: 'pending',
          description: `Refund (pending to original payment method) — scheduled trip on ${claimed.departureDate} did not run`,
        }).catch((e) =>
          console.warn('[scheduled sweep] pending refund row failed:', e),
        );

        try {
          const { sendPushToUser } = await import('../controllers/fcmController');
          const { templatedCopy } = await import('./notificationTemplate');
          const copy = await templatedCopy(
            'scheduled.trip_expired_refund_pending',
            { date: claimed.departureDate, amount: refund },
            {
              title: 'Refund processing',
              body: `Your scheduled trip on ${claimed.departureDate} did not run. Your refund is being processed.`,
            },
          );
          await sendPushToUser(String(claimed.customer), {
            title: copy.title,
            body: copy.body,
            data: {
              kind: 'scheduled:expired-refund',
              bookingId: String(claimed._id),
            },
          });
        } catch {
          /* best-effort */
        }
      }
    } catch (err) {
      console.error(
        '[scheduled sweep] failed for booking',
        String(b._id),
        err,
      );
    }
  }

  // ── 2) Expire never-started journeys for past dates ──
  let journeysExpired = 0;
  try {
    const result = await DriverJourney.updateMany(
      { status: 'scheduled', departureDate: { $lt: today } },
      { $set: { status: 'expired' } },
    );
    journeysExpired = result.modifiedCount ?? 0;
  } catch (err) {
    console.error('[scheduled sweep] journey expiry failed:', err);
  }

  // ── 3) Expire started-but-abandoned journeys ──
  // A journey stuck 'active'/'in_progress' forever froze its riders' money
  // permanently: pass 1 skips running journeys' bookings, rider cancel is
  // blocked by the underway guard, and nothing else could clear it. Two full
  // IST days past the departure date it is definitively dead — yesterday is
  // grace for a legitimately midnight-crossing run.
  const abandonedCutoff = istDateStrPlusDays(-1); // strictly before yesterday
  try {
    const abandoned = await DriverJourney.find({
      status: { $in: ['active', 'in_progress'] },
      departureDate: { $lt: abandonedCutoff },
    })
      .select('route driver departureIndex departureDate')
      .limit(100)
      .lean();

    for (const j of abandoned) {
      try {
        // Atomic claim so an overlapping sweep processes each journey once.
        const claimedJourney = await DriverJourney.findOneAndUpdate(
          { _id: j._id, status: { $in: ['active', 'in_progress'] } },
          { $set: { status: 'expired' } },
          { new: true },
        );
        if (!claimedJourney) continue;
        journeysExpired += 1;

        // Riders with boarded seats actually rode — settle their bookings as
        // 'completed'. No wallet ops and no driver settlement (that only runs
        // from journey completion, which never happened).
        await ScheduledBooking.updateMany(
          {
            route: j.route,
            driver: j.driver,
            departureIndex: j.departureIndex,
            departureDate: j.departureDate,
            status: 'reserved',
            'boardedSeats.0': { $exists: true },
          },
          { $set: { status: 'completed' } },
        );
        // Unboarded reserved bookings are deliberately left alone: with the
        // journey now 'expired' (not in pass 1's skip list) the next sweep's
        // booking-expiry pass claims and refunds them.
      } catch (err) {
        console.error(
          '[scheduled sweep] abandoned journey cleanup failed for',
          String(j._id),
          err,
        );
      }
    }
  } catch (err) {
    console.error('[scheduled sweep] abandoned journey sweep failed:', err);
  }

  if (bookingsExpired > 0 || journeysExpired > 0) {
    console.log(
      `[scheduled sweep] expired ${bookingsExpired} booking(s) (INR ${refundedTotal} refunded), ${journeysExpired} journey(s)`,
    );
  }
  return { bookingsExpired, journeysExpired };
}
