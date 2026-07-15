import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * A rider's seat reservation on a scheduled (shuttle) route. One row per
 * confirmed booking; the seat numbers live as a small array so two riders
 * on the same trip share the doc-ID space cleanly and seat-availability
 * lookups are a single Mongo query.
 *
 *   route          — Route._id the booking is against.
 *   departureDate  — YYYY-MM-DD of the trip (no time component; the slot
 *                    is identified by departureIndex below).
 *   departureIndex — Index into Route.schedule.departures so we know
 *                    which time slot of the day was booked.
 *   driver         — User._id of the driver whose vehicle this seat is on.
 *                    Seats are namespaced per vehicle: each approved driver
 *                    on a route+departure runs their own shuttle of
 *                    schedule.totalSeats seats, so seat #3 on driver A's
 *                    vehicle is independent of seat #3 on driver B's.
 *   seats          — 1-based seat numbers reserved by this rider.
 *   customer       — User._id of the rider.
 *   status         — 'reserved' (default) → 'cancelled' on user cancel.
 *
 * The composite uniqueness invariant ("two riders can't hold the same
 * seat on the same trip+vehicle") is enforced at the controller level via
 * an atomic check-then-write. We index by (route, departureDate,
 * departureIndex, driver, status) so the per-vehicle seat-lookup is fast.
 */
export interface IScheduledBooking extends Document {
  _id: Types.ObjectId;
  route: Types.ObjectId;
  departureDate: string; // YYYY-MM-DD
  departureIndex: number;
  driver?: Types.ObjectId;
  seats: number[];
  /** Per-seat passenger details captured during booking. Persisted so the
   *  ticket / Activity history can show who each seat is for after the fact
   *  (the booking flow only had them in nav params before). */
  passengers?: { seat: number; name: string; contact?: string }[];
  customer: Types.ObjectId;
  status: 'reserved' | 'cancelled' | 'completed';
  totalAmount: number;
  /** How the rider paid. 'wallet' bookings are auto-refunded to the wallet on
   *  cancel; 'razorpay' refunds are handled by support/admin out of band.
   *  Absent on legacy rows created before server-side wallet debits existed. */
  paymentMethod?: 'wallet' | 'razorpay';
  /** Subset of `seats` the driver has boarded on the trip (per-seat check-in). */
  boardedSeats?: number[];
  /** Subset of `seats` the driver marked no-show (rider didn't turn up). These
   *  are excluded from the driver's settlement; any refund is admin-driven. */
  noShowSeats?: number[];
  /** Subset of `seats` the driver dropped off EARLY (before the booked stop),
   *  at the rider's request. The seat stays boarded (the rider paid and rode),
   *  so this does NOT affect settlement — it's an operational record so admin/
   *  history can see the early drop. */
  droppedSeats?: number[];
  /** First time any seat on this booking boarded. */
  boardedAt?: Date;
  /** Who cancelled the seat and why. Populated on cancel so admin/customer
   *  history can show the same "cancelled by + reason" detail that Ride
   *  records carry. */
  cancellation?: {
    cancelledBy: 'customer' | 'driver' | 'admin' | 'system';
    reason: string;
    cancelledAt: Date;
  };
  createdAt: Date;
  updatedAt: Date;
}

const scheduledBookingSchema = new Schema<IScheduledBooking>(
  {
    route: { type: Schema.Types.ObjectId, ref: 'Route', required: true, index: true },
    departureDate: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },
    departureIndex: { type: Number, required: true, min: 0 },
    driver: { type: Schema.Types.ObjectId, ref: 'User' },
    seats: {
      type: [Number],
      required: true,
      validate: {
        validator: (v: number[]) => Array.isArray(v) && v.length >= 1 && v.every((n) => Number.isInteger(n) && n > 0),
        message: 'seats must be a non-empty array of positive integers',
      },
    },
    passengers: {
      type: [
        {
          seat: { type: Number },
          name: { type: String },
          contact: { type: String },
        },
      ],
      default: [],
    },
    customer: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    status: {
      type: String,
      enum: ['reserved', 'cancelled', 'completed'],
      default: 'reserved',
      index: true,
    },
    totalAmount: { type: Number, default: 0, min: 0 },
    paymentMethod: { type: String, enum: ['wallet', 'razorpay'] },
    boardedSeats: { type: [Number], default: [] },
    noShowSeats: { type: [Number], default: [] },
    droppedSeats: { type: [Number], default: [] },
    boardedAt: { type: Date },
    cancellation: {
      cancelledBy: { type: String, enum: ['customer', 'driver', 'admin', 'system'] },
      reason: String,
      cancelledAt: Date,
    },
  },
  { timestamps: true },
);

// One composite index serves both the seat-availability lookup and the
// booking-conflict check during reservation.
scheduledBookingSchema.index({
  route: 1,
  departureDate: 1,
  departureIndex: 1,
  driver: 1,
  status: 1,
});

export const ScheduledBooking = mongoose.model<IScheduledBooking>(
  'ScheduledBooking',
  scheduledBookingSchema,
);
