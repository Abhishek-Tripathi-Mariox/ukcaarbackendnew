import mongoose, { Schema, Document, Types } from 'mongoose';

export type IncentivePeriod = 'daily' | 'weekly' | 'monthly';
export type IncentiveTarget = 'rides' | 'earnings';
export type IncentiveRewardType = 'flat' | 'percentage';

export interface IDriverIncentive extends Document {
  _id: Types.ObjectId;
  name: string;
  description?: string;
  active: boolean;

  period: IncentivePeriod;
  target: IncentiveTarget;
  threshold: number;
  rewardType: IncentiveRewardType;
  rewardAmount: number;

  // Eligibility filters
  rideTypes?: string[];
  vehicleTypes?: string[];
  minRating?: number;
  driverIds?: Types.ObjectId[]; // if set, only these drivers

  startDate?: Date;
  endDate?: Date;

  createdBy?: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const driverIncentiveSchema = new Schema<IDriverIncentive>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, maxlength: 500 },
    active: { type: Boolean, default: true, index: true },

    period: {
      type: String,
      enum: ['daily', 'weekly', 'monthly'],
      required: true,
    },
    target: {
      type: String,
      enum: ['rides', 'earnings'],
      required: true,
    },
    threshold: { type: Number, required: true, min: 0 },
    rewardType: {
      type: String,
      enum: ['flat', 'percentage'],
      required: true,
    },
    rewardAmount: { type: Number, required: true, min: 0 },

    rideTypes: [{ type: String }],
    vehicleTypes: [{ type: String }],
    minRating: { type: Number, min: 0, max: 5 },
    driverIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],

    startDate: Date,
    endDate: Date,

    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

driverIncentiveSchema.index({ active: 1, startDate: 1, endDate: 1 });

export const DriverIncentive = mongoose.model<IDriverIncentive>(
  'DriverIncentive',
  driverIncentiveSchema
);

// ════════════════════════════════════════════════════════════════════
// Per-driver-per-period progress
// ════════════════════════════════════════════════════════════════════

export interface IDriverIncentiveProgress extends Document {
  _id: Types.ObjectId;
  incentive: Types.ObjectId;
  driver: Types.ObjectId;
  periodKey: string;          // e.g. '2026-04-28', '2026-W17', '2026-04'
  periodStart: Date;
  periodEnd: Date;

  target: IncentiveTarget;    // snapshot
  threshold: number;          // snapshot
  rewardType: IncentiveRewardType;
  rewardAmountConfig: number; // snapshot of rule

  rideCount: number;
  earnings: number;           // accumulated driverEarnings
  progress: number;           // value compared against threshold (rides → rideCount, earnings → earnings)

  earned: boolean;
  earnedAt?: Date;
  rewardAmount: number;       // computed payout

  paidOut: boolean;
  paidOutAt?: Date;
  paidOutBy?: Types.ObjectId;
  paymentRef?: string;
  notes?: string;

  createdAt: Date;
  updatedAt: Date;
}

const progressSchema = new Schema<IDriverIncentiveProgress>(
  {
    incentive: { type: Schema.Types.ObjectId, ref: 'DriverIncentive', required: true, index: true },
    driver: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    periodKey: { type: String, required: true },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },

    target: { type: String, enum: ['rides', 'earnings'], required: true },
    threshold: { type: Number, required: true },
    rewardType: { type: String, enum: ['flat', 'percentage'], required: true },
    rewardAmountConfig: { type: Number, required: true },

    rideCount: { type: Number, default: 0 },
    earnings: { type: Number, default: 0 },
    progress: { type: Number, default: 0 },

    earned: { type: Boolean, default: false, index: true },
    earnedAt: Date,
    rewardAmount: { type: Number, default: 0 },

    paidOut: { type: Boolean, default: false, index: true },
    paidOutAt: Date,
    paidOutBy: { type: Schema.Types.ObjectId, ref: 'User' },
    paymentRef: String,
    notes: String,
  },
  { timestamps: true }
);

progressSchema.index({ incentive: 1, driver: 1, periodKey: 1 }, { unique: true });
progressSchema.index({ driver: 1, earned: 1, paidOut: 1 });

export const DriverIncentiveProgress = mongoose.model<IDriverIncentiveProgress>(
  'DriverIncentiveProgress',
  progressSchema
);
