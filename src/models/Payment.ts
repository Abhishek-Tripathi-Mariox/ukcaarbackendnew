import mongoose, { Document, Schema } from 'mongoose';

export interface IPayment extends Document {
  user: mongoose.Types.ObjectId;
  ride?: mongoose.Types.ObjectId;
  /**
   * Payment kinds:
   * - ride_payment   : driver earnings (gross fare minus driver-keeps split, but
   *                    in this codebase we record the net `driverEarnings` here)
   * - commission     : platform fee taken on a ride (paired with ride_payment)
   * - wallet_topup   : driver recharges their wallet via Razorpay
   * - cashout        : driver withdraws balance to bank/UPI
   * - tip            : rider-paid tip added on top of fare
   * - refund         : refunded to user (positive sign)
   * - cancellation_fee, subscription, incentive, bonus : self-explanatory
   */
  type:
    | 'ride_payment'
    | 'scheduled_booking'
    | 'commission'
    | 'wallet_topup'
    | 'cashout'
    | 'tip'
    | 'refund'
    | 'subscription'
    | 'cancellation_fee'
    | 'adjustment'
    | 'incentive'
    | 'bonus';
  amount: number;
  currency: string;
  method: 'card' | 'cash' | 'wallet' | 'bank_transfer' | 'upi';
  status: 'pending' | 'completed' | 'failed' | 'refunded';
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  /**
   * For wallet_topup: the amount actually credited to the wallet on success.
   * Differs from `amount` (the money charged via Razorpay) when an offer adds
   * a bonus or applies a discount. Crediting code uses `walletCredit ?? amount`
   * so legacy rows without this field still credit the charged amount.
   */
  walletCredit?: number;
  /** For wallet_topup: the bonus portion of walletCredit, for analytics. */
  bonusAmount?: number;
  /** For wallet_topup: the recharge offer this top-up used, if any. */
  rechargeOffer?: mongoose.Types.ObjectId;
  /** For subscription (OnePass): which plan key was purchased (weekly/monthly/annual). */
  subscriptionPlan?: string;
  /** For subscription (OnePass): validity days snapshotted at order time, so activation survives later plan edits. */
  subscriptionDays?: number;
  /** For cashout: which payout channel was requested. */
  payoutMethod?: 'bank' | 'upi';
  /** For cashout: snapshot of the destination so it survives bank-detail edits. */
  payoutDestination?: {
    bankName?: string;
    accountLast4?: string;
    upiId?: string;
  };
  description: string;
  createdAt: Date;
  updatedAt: Date;
}

const paymentSchema = new Schema<IPayment>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    ride: { type: Schema.Types.ObjectId, ref: 'Ride' },
    type: {
      type: String,
      enum: [
        'ride_payment',
        'scheduled_booking',
        'commission',
        'wallet_topup',
        'cashout',
        'tip',
        'refund',
        'subscription',
        'cancellation_fee',
        'adjustment',
        'incentive',
        'bonus',
      ],
      required: true,
    },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'INR' },
    method: {
      type: String,
      enum: ['card', 'cash', 'wallet', 'bank_transfer', 'upi'],
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'completed', 'failed', 'refunded'],
      default: 'pending',
    },
    razorpayOrderId: String,
    razorpayPaymentId: String,
    walletCredit: { type: Number },
    bonusAmount: { type: Number },
    rechargeOffer: { type: Schema.Types.ObjectId, ref: 'RechargeOffer' },
    subscriptionPlan: { type: String },
    subscriptionDays: { type: Number },
    payoutMethod: { type: String, enum: ['bank', 'upi'] },
    payoutDestination: {
      bankName: String,
      accountLast4: String,
      upiId: String,
    },
    description: { type: String, required: true },
  },
  { timestamps: true }
);

paymentSchema.index({ user: 1, createdAt: -1 });
paymentSchema.index({ ride: 1 });
paymentSchema.index({ status: 1 });

export const Payment = mongoose.model<IPayment>('Payment', paymentSchema);


// ── Wallet Model ──
export interface IWallet extends Document {
  user: mongoose.Types.ObjectId;
  balance: number;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
}

const walletSchema = new Schema<IWallet>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    balance: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: 'INR' },
  },
  { timestamps: true }
);

export const Wallet = mongoose.model<IWallet>('Wallet', walletSchema);


// ── Saved Payment Method Model ──
export interface ISavedPaymentMethod extends Document {
  user: mongoose.Types.ObjectId;
  type: 'credit_card' | 'debit_card' | 'upi' | 'wallet';
  // Card fields
  brand?: string;       // visa, mastercard, amex, discover, rupay
  last4?: string;
  cardHolderName?: string;
  expiryMonth?: number;
  expiryYear?: number;
  razorpayTokenId?: string;
  // UPI fields
  upiId?: string;
  // Wallet fields (PhonePe, Paytm, etc.)
  walletProvider?: string;
  walletEmail?: string;
  // Common
  label: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const savedPaymentMethodSchema = new Schema<ISavedPaymentMethod>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: {
      type: String,
      enum: ['credit_card', 'debit_card', 'upi', 'wallet'],
      required: true,
    },
    brand: String,
    last4: String,
    cardHolderName: String,
    expiryMonth: Number,
    expiryYear: Number,
    razorpayTokenId: String,
    upiId: String,
    walletProvider: String,
    walletEmail: String,
    label: { type: String, required: true },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true }
);

savedPaymentMethodSchema.index({ user: 1 });

export const SavedPaymentMethod = mongoose.model<ISavedPaymentMethod>(
  'SavedPaymentMethod',
  savedPaymentMethodSchema
);

