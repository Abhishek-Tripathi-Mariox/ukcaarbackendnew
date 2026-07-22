import mongoose, { Document, Schema } from 'mongoose';

export interface IRide extends Document {
  customer: mongoose.Types.ObjectId;
  driver?: mongoose.Types.ObjectId;
  // Admin-managed VehicleType.code (e.g. 'sedan', 'muv', 'auto',
  // 'premium-suv'). The legacy fixed enum has been retired — the catalogue
  // is configurable from the admin panel.
  rideType: string;
  status:
    | 'searching'
    | 'driver_assigned'
    | 'driver_arriving'
    | 'driver_arrived'
    | 'in_progress'
    // Trip has physically ended but settlement is outstanding. We sit
    // here until the customer pays (wallet/Razorpay) OR the driver
    // confirms cash receipt — only then does the ride transition to
    // 'completed'.
    | 'payment_pending'
    | 'completed'
    | 'cancelled';

  pickup: {
    address: string;
    lat: number;
    lng: number;
  };
  dropoff: {
    address: string;
    lat: number;
    lng: number;
  };
  stops?: {
    address: string;
    lat: number;
    lng: number;
  }[];

  estimatedDistance: number; // km
  estimatedDuration: number; // minutes
  actualDistance?: number;
  actualDuration?: number;

  estimatedFare: number;
  actualFare?: number;
  baseFare: number;
  distanceFare: number;
  timeFare: number;
  surgeFare: number;
  discount: number;
  tip: number;
  commission: number;
  driverEarnings: number;

  paymentMethod: 'card' | 'cash' | 'wallet';
  paymentStatus: 'pending' | 'completed' | 'refunded' | 'failed';
  promoCode?: string;

  /** Loyalty voucher consumed on this ride (issued by a reward redemption). */
  loyaltyRedemption?: mongoose.Types.ObjectId;
  /** ₹ taken off by loyalty (tier discount + redeemed voucher), for transparency. */
  loyaltyDiscount?: number;

  isScheduled: boolean;
  scheduledAt?: Date;
  returnDeparture?: {
    time: string;          // 'HH:MM' 24h
    scheduledFor: Date;    // absolute date+time
  };
  isPrivate: boolean;

  rating?: {
    customerToDriver: number;
    driverToCustomer: number;
    customerComment?: string;
    driverComment?: string;
    tags?: string[];
  };

  cancellation?: {
    cancelledBy: 'customer' | 'driver' | 'admin' | 'system';
    reason: string;
    fee: number;
    /** Money actually returned to the rider for this cancellation. 0 when the
     *  ride was never paid (the normal case — payment happens at completion).
     *  The app shows a "refunded" line only when this is > 0, so it must never
     *  be inferred from the fare. */
    refundAmount: number;
    cancelledAt: Date;
  };

  /**
   * Dispute resolution record. A ride is *flagged* as disputed dynamically
   * (low rating or a cancellation fee — see GET /admin/rides/disputed); this
   * subdocument is written only when an admin resolves it, so the disputes
   * queue can exclude already-handled cases.
   */
  dispute?: {
    resolved: boolean;
    resolution?: string;
    notes?: string;
    refundAmount?: number;
    resolvedBy?: mongoose.Types.ObjectId;
    resolvedAt?: Date;
  };

  route?: {
    encodedPolyline: string;
  };

  /** 4-digit OTP shown to the customer; driver enters it to confirm pickup.
   *  Cleared (set to undefined) once verification succeeds. */
  pickupOtp?: string;

  /** Drivers who declined this request before someone else accepted it.
   *  Capped at last 20 entries to keep documents small. */
  rejections?: {
    driver: mongoose.Types.ObjectId;
    reason?: string;
    rejectedAt: Date;
  }[];

  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const rideSchema = new Schema<IRide>(
  {
    customer: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    driver: { type: Schema.Types.ObjectId, ref: 'User' },
    rideType: {
      type: String,
      required: true,
      // No enum: vehicle types are admin-managed (see VehicleType collection),
      // so the set of valid codes changes at runtime. A trim + lowercase is
      // enough to keep stored codes consistent across rides.
      trim: true,
      lowercase: true,
    },
    status: {
      type: String,
      enum: [
        'searching',
        'driver_assigned',
        'driver_arriving',
        'driver_arrived',
        'in_progress',
        'payment_pending',
        'completed',
        'cancelled',
      ],
      default: 'searching',
    },

    pickup: {
      address: { type: String, required: true },
      lat: { type: Number, required: true },
      lng: { type: Number, required: true },
    },
    dropoff: {
      address: { type: String, required: true },
      lat: { type: Number, required: true },
      lng: { type: Number, required: true },
    },
    stops: [
      {
        address: String,
        lat: Number,
        lng: Number,
      },
    ],

    estimatedDistance: { type: Number, required: true },
    estimatedDuration: { type: Number, required: true },
    actualDistance: Number,
    actualDuration: Number,

    estimatedFare: { type: Number, required: true },
    actualFare: Number,
    baseFare: { type: Number, default: 0 },
    distanceFare: { type: Number, default: 0 },
    timeFare: { type: Number, default: 0 },
    surgeFare: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    tip: { type: Number, default: 0 },
    commission: { type: Number, default: 0 },
    driverEarnings: { type: Number, default: 0 },

    paymentMethod: {
      type: String,
      enum: ['card', 'cash', 'wallet'],
      default: 'card',
    },
    loyaltyRedemption: { type: Schema.Types.ObjectId, ref: 'LoyaltyRedemption' },
    loyaltyDiscount: { type: Number, default: 0 },

    paymentStatus: {
      type: String,
      enum: ['pending', 'completed', 'refunded', 'failed'],
      default: 'pending',
    },
    promoCode: String,

    isScheduled: { type: Boolean, default: false },
    scheduledAt: Date,
    returnDeparture: {
      type: new Schema(
        {
          time: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
          scheduledFor: { type: Date, required: true },
        },
        { _id: false },
      ),
      required: false,
    },
    isPrivate: { type: Boolean, default: false },

    rating: {
      customerToDriver: Number,
      driverToCustomer: Number,
      customerComment: String,
      driverComment: String,
      tags: [String],
    },

    cancellation: {
      cancelledBy: { type: String, enum: ['customer', 'driver', 'admin', 'system'] },
      reason: String,
      fee: { type: Number, default: 0 },
      refundAmount: { type: Number, default: 0 },
      cancelledAt: Date,
    },

    dispute: {
      resolved: { type: Boolean, default: false },
      resolution: String,
      notes: String,
      refundAmount: { type: Number, default: 0 },
      resolvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
      resolvedAt: Date,
    },

    // 4-digit pickup OTP. Generated at ride creation, shown to the customer
    // in their tracking screen, entered by the driver to confirm the
    // correct passenger before starting the trip. Cleared (set to undefined)
    // once verification succeeds.
    pickupOtp: { type: String },

    // Drivers who declined this request before someone else accepted it.
    // Capped at last 20 entries to keep documents small. Used by ops to
    // spot drivers with high reject rates.
    rejections: [
      {
        driver: { type: Schema.Types.ObjectId, ref: 'User' },
        reason: String,
        rejectedAt: { type: Date, default: Date.now },
      },
    ],

    route: {
      encodedPolyline: String,
    },

    startedAt: Date,
    completedAt: Date,
  },
  {
    timestamps: true,
  }
);

// ── Indexes ──
rideSchema.index({ customer: 1, createdAt: -1 });
rideSchema.index({ driver: 1, createdAt: -1 });
rideSchema.index({ status: 1 });
rideSchema.index({ createdAt: -1 });
rideSchema.index({ 'pickup.lat': 1, 'pickup.lng': 1 });

export const Ride = mongoose.model<IRide>('Ride', rideSchema);
