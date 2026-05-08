import mongoose, { Document, Schema } from 'mongoose';

export interface IRide extends Document {
  customer: mongoose.Types.ObjectId;
  driver?: mongoose.Types.ObjectId;
  rideType: 'economy' | 'comfort' | 'premium' | 'xl' | 'electric';
  status:
    | 'searching'
    | 'driver_assigned'
    | 'driver_arriving'
    | 'driver_arrived'
    | 'in_progress'
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

  isScheduled: boolean;
  scheduledAt?: Date;
  isPrivate: boolean;

  rating?: {
    customerToDriver: number;
    driverToCustomer: number;
    customerComment?: string;
    driverComment?: string;
    tags?: string[];
  };

  cancellation?: {
    cancelledBy: 'customer' | 'driver' | 'system';
    reason: string;
    fee: number;
    cancelledAt: Date;
  };

  route?: {
    encodedPolyline: string;
  };

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
      enum: ['economy', 'comfort', 'premium', 'xl', 'electric'],
      required: true,
    },
    status: {
      type: String,
      enum: [
        'searching',
        'driver_assigned',
        'driver_arriving',
        'driver_arrived',
        'in_progress',
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
    paymentStatus: {
      type: String,
      enum: ['pending', 'completed', 'refunded', 'failed'],
      default: 'pending',
    },
    promoCode: String,

    isScheduled: { type: Boolean, default: false },
    scheduledAt: Date,
    isPrivate: { type: Boolean, default: false },

    rating: {
      customerToDriver: Number,
      driverToCustomer: Number,
      customerComment: String,
      driverComment: String,
      tags: [String],
    },

    cancellation: {
      cancelledBy: { type: String, enum: ['customer', 'driver', 'system'] },
      reason: String,
      fee: { type: Number, default: 0 },
      cancelledAt: Date,
    },

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
