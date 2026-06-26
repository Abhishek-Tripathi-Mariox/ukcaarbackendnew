import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * Flexible subscription system for drivers and customers — the admin-managed
 * counterpart to the legacy hard-coded OnePass. A SubscriptionPlan is a
 * template (price, validity, ride cap, commission); a UserSubscription is an
 * individual grant of a plan to a user.
 *
 * The "fare as subscription for two/three-wheelers" requirement is modelled
 * as a plan with type 'commission' or a flat plan whose `commissionRate`
 * overrides the per-ride cut while the subscription is active. Applying that
 * to live fare calculation happens app-side; this layer makes the plans
 * manageable and grantable from the admin panel.
 */

export type PlanType = 'monthly' | 'weekly' | 'daily' | 'annual' | 'ride_pack' | 'commission';
export type PlanTarget = 'driver' | 'customer';

export interface ISubscriptionPlan extends Document {
  _id: Types.ObjectId;
  name: string;
  type: PlanType;
  target: PlanTarget;
  /** Upfront price in INR. 0 for pure-commission plans. */
  price: number;
  /** % cut per ride while the plan is active. 0 for flat plans. */
  commissionRate: number;
  /** Capped number of rides; null = unlimited. */
  rideLimit: number | null;
  validityDays: number;
  benefits: string[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const subscriptionPlanSchema = new Schema<ISubscriptionPlan>(
  {
    name: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: ['monthly', 'weekly', 'daily', 'annual', 'ride_pack', 'commission'],
      default: 'monthly',
    },
    target: { type: String, enum: ['driver', 'customer'], default: 'driver' },
    price: { type: Number, default: 0, min: 0 },
    commissionRate: { type: Number, default: 0, min: 0, max: 100 },
    rideLimit: { type: Number, default: null },
    validityDays: { type: Number, default: 30, min: 1 },
    benefits: { type: [String], default: [] },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

export const SubscriptionPlan = mongoose.model<ISubscriptionPlan>(
  'SubscriptionPlan',
  subscriptionPlanSchema,
);

export type SubscriptionStatus = 'active' | 'expired' | 'cancelled' | 'pending';

export interface IUserSubscription extends Document {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  userType: PlanTarget;
  plan: Types.ObjectId;
  status: SubscriptionStatus;
  startDate: Date;
  endDate: Date;
  ridesUsed: number;
  autoRenew: boolean;
  /** Amount actually collected for this grant (0 for free admin grants). */
  pricePaid: number;
  grantedBy?: Types.ObjectId;
  grantReason?: string;
  cancellation?: {
    reason: string;
    cancelledAt: Date;
  };
  createdAt: Date;
  updatedAt: Date;
}

const userSubscriptionSchema = new Schema<IUserSubscription>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    userType: { type: String, enum: ['driver', 'customer'], required: true },
    plan: { type: Schema.Types.ObjectId, ref: 'SubscriptionPlan', required: true, index: true },
    status: {
      type: String,
      enum: ['active', 'expired', 'cancelled', 'pending'],
      default: 'active',
      index: true,
    },
    startDate: { type: Date, default: Date.now },
    endDate: { type: Date, required: true },
    ridesUsed: { type: Number, default: 0, min: 0 },
    autoRenew: { type: Boolean, default: false },
    pricePaid: { type: Number, default: 0, min: 0 },
    grantedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    grantReason: String,
    cancellation: {
      reason: String,
      cancelledAt: Date,
    },
  },
  { timestamps: true },
);

export const UserSubscription = mongoose.model<IUserSubscription>(
  'UserSubscription',
  userSubscriptionSchema,
);
