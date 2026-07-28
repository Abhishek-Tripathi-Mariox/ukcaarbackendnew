import mongoose, { Schema, Document, Types } from 'mongoose';

// ════════════════════════════════════════════════════════════════════
// LoyaltyTier — admin-configured tier ladder
// ════════════════════════════════════════════════════════════════════

export interface ILoyaltyTier extends Document {
  _id: Types.ObjectId;
  key: string;                  // e.g. 'bronze' (unique, lowercase)
  name: string;                 // 'Bronze'
  order: number;                // 1, 2, 3 ...
  minLifetimePoints: number;    // entry threshold (lifetime points required)
  perksDescription?: string;
  // Multipliers — applied when earning points / using as discount
  earnMultiplier: number;       // default 1.0
  rideDiscountPct: number;      // 0..100 — automatic % discount
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const tierSchema = new Schema<ILoyaltyTier>(
  {
    key: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true },
    order: { type: Number, required: true, default: 1 },
    minLifetimePoints: { type: Number, required: true, default: 0 },
    perksDescription: String,
    earnMultiplier: { type: Number, default: 1.0, min: 0 },
    rideDiscountPct: { type: Number, default: 0, min: 0, max: 100 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

tierSchema.index({ order: 1 });

export const LoyaltyTier = mongoose.model<ILoyaltyTier>('LoyaltyTier', tierSchema);

// ════════════════════════════════════════════════════════════════════
// LoyaltyAccount — per-customer points balance + tier
// ════════════════════════════════════════════════════════════════════

export interface ILoyaltyAccount extends Document {
  _id: Types.ObjectId;
  user: Types.ObjectId;         // unique
  pointsBalance: number;
  lifetimePoints: number;
  tier?: Types.ObjectId | null; // ref LoyaltyTier
  tierKey?: string;
  tierAchievedAt?: Date;
  lastEarnAt?: Date;
  lastRedeemAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const accountSchema = new Schema<ILoyaltyAccount>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    pointsBalance: { type: Number, default: 0, min: 0 },
    lifetimePoints: { type: Number, default: 0, min: 0 },
    tier: { type: Schema.Types.ObjectId, ref: 'LoyaltyTier' },
    tierKey: String,
    tierAchievedAt: Date,
    lastEarnAt: Date,
    lastRedeemAt: Date,
  },
  { timestamps: true }
);

export const LoyaltyAccount = mongoose.model<ILoyaltyAccount>(
  'LoyaltyAccount',
  accountSchema
);

// ════════════════════════════════════════════════════════════════════
// LoyaltyTransaction — points ledger
// ════════════════════════════════════════════════════════════════════

export type LoyaltyTxnType =
  | 'earn_ride'
  | 'earn_signup'
  | 'earn_referral'
  | 'earn_promo'
  | 'admin_credit'
  | 'admin_debit'
  | 'redeem_ride'
  | 'redeem_reward'
  | 'expire'
  | 'reverse';

export interface ILoyaltyTransaction extends Document {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  type: LoyaltyTxnType;
  points: number;               // positive = credit, negative = debit
  ride?: Types.ObjectId;
  payment?: Types.ObjectId;
  reward?: Types.ObjectId;
  description?: string;
  reference?: string;
  performedBy?: Types.ObjectId; // admin user for manual ops
  balanceAfter: number;
  metadata?: Record<string, any>;
  createdAt: Date;
}

const txnSchema = new Schema<ILoyaltyTransaction>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: {
      type: String,
      enum: [
        'earn_ride',
        'earn_signup',
        'earn_referral',
        'earn_promo',
        'admin_credit',
        'admin_debit',
        'redeem_ride',
        'redeem_reward',
        'expire',
        'reverse',
      ],
      required: true,
    },
    points: { type: Number, required: true },
    ride: { type: Schema.Types.ObjectId, ref: 'Ride' },
    payment: { type: Schema.Types.ObjectId, ref: 'Payment' },
    reward: { type: Schema.Types.ObjectId, ref: 'LoyaltyReward' },
    description: String,
    reference: String,
    performedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    balanceAfter: { type: Number, required: true },
    metadata: Schema.Types.Mixed,
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

txnSchema.index({ user: 1, createdAt: -1 });
txnSchema.index({ type: 1, createdAt: -1 });

export const LoyaltyTransaction = mongoose.model<ILoyaltyTransaction>(
  'LoyaltyTransaction',
  txnSchema
);

// ════════════════════════════════════════════════════════════════════
// LoyaltyReward — redemption catalog
// ════════════════════════════════════════════════════════════════════

export type RewardType =
  | 'ride_discount_flat'
  | 'ride_discount_pct'
  | 'free_ride'
  | 'wallet_credit'
  | 'voucher';

export interface ILoyaltyReward extends Document {
  _id: Types.ObjectId;
  name: string;
  description?: string;
  type: RewardType;
  pointsCost: number;
  value: number;                // ₹ for flat / wallet / voucher; % for pct
  maxRedemptionsPerUser?: number;
  totalRedemptionLimit?: number;
  totalRedemptionsCount: number;
  validFrom?: Date;
  validUntil?: Date;
  minTierKey?: string;
  active: boolean;
  imageUrl?: string;
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const rewardSchema = new Schema<ILoyaltyReward>(
  {
    name: { type: String, required: true, maxlength: 120 },
    description: { type: String, maxlength: 1000 },
    type: {
      type: String,
      enum: ['ride_discount_flat', 'ride_discount_pct', 'free_ride', 'wallet_credit', 'voucher'],
      required: true,
    },
    pointsCost: { type: Number, required: true, min: 1 },
    value: { type: Number, required: true, min: 0 },
    maxRedemptionsPerUser: { type: Number, min: 0 },
    totalRedemptionLimit: { type: Number, min: 0 },
    totalRedemptionsCount: { type: Number, default: 0 },
    validFrom: Date,
    validUntil: Date,
    minTierKey: String,
    active: { type: Boolean, default: true, index: true },
    imageUrl: String,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export const LoyaltyReward = mongoose.model<ILoyaltyReward>('LoyaltyReward', rewardSchema);

// ════════════════════════════════════════════════════════════════════
// LoyaltyRedemption — issued voucher / claim record
// ════════════════════════════════════════════════════════════════════

export type RedemptionStatus = 'issued' | 'used' | 'expired' | 'cancelled';

export interface ILoyaltyRedemption extends Document {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  reward: Types.ObjectId;
  rewardSnapshot: {
    name: string;
    type: RewardType;
    value: number;
    pointsCost: number;
  };
  code: string;                 // voucher code
  status: RedemptionStatus;
  issuedAt: Date;
  expiresAt?: Date;
  usedAt?: Date;
  usedRide?: Types.ObjectId;
  cancelledAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const redemptionSchema = new Schema<ILoyaltyRedemption>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    reward: { type: Schema.Types.ObjectId, ref: 'LoyaltyReward', required: true },
    // Each field must use the `{ type: X }` long form. A bare `type: String`
    // inside a nested object makes Mongoose read `type` as this path's own
    // SchemaType, collapsing the whole snapshot into a single String path —
    // which then throws "Cast to string failed" on every create().
    rewardSnapshot: {
      name: { type: String },
      type: { type: String },
      value: { type: Number },
      pointsCost: { type: Number },
    },
    code: { type: String, required: true, unique: true, uppercase: true },
    status: {
      type: String,
      enum: ['issued', 'used', 'expired', 'cancelled'],
      default: 'issued',
      index: true,
    },
    issuedAt: { type: Date, default: Date.now },
    expiresAt: Date,
    usedAt: Date,
    usedRide: { type: Schema.Types.ObjectId, ref: 'Ride' },
    cancelledAt: Date,
  },
  { timestamps: true }
);

redemptionSchema.index({ user: 1, status: 1 });

export const LoyaltyRedemption = mongoose.model<ILoyaltyRedemption>(
  'LoyaltyRedemption',
  redemptionSchema
);
