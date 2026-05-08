import mongoose, { Document, Schema } from 'mongoose';

export interface IPayment extends Document {
  user: mongoose.Types.ObjectId;
  ride?: mongoose.Types.ObjectId;
  type: 'ride_payment' | 'wallet_topup' | 'tip' | 'refund' | 'subscription' | 'cancellation_fee';
  amount: number;
  currency: string;
  method: 'card' | 'cash' | 'wallet';
  status: 'pending' | 'completed' | 'failed' | 'refunded';
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
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
      enum: ['ride_payment', 'wallet_topup', 'tip', 'refund', 'subscription', 'cancellation_fee'],
      required: true,
    },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'INR' },
    method: { type: String, enum: ['card', 'cash', 'wallet'], required: true },
    status: {
      type: String,
      enum: ['pending', 'completed', 'failed', 'refunded'],
      default: 'pending',
    },
    razorpayOrderId: String,
    razorpayPaymentId: String,
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

