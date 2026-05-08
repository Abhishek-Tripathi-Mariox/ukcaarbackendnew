import mongoose, { Document, Schema } from 'mongoose';

export type SettlementStatus = 'pending' | 'matched' | 'mismatch' | 'failed' | 'reconciled';

export interface ISettlement extends Document {
  // Razorpay identifiers
  razorpaySettlementId: string;
  razorpayPaymentId?: string;
  razorpayOrderId?: string;
  utr?: string;

  // Linked records
  payment?: mongoose.Types.ObjectId;
  ride?: mongoose.Types.ObjectId;

  // Money flow (in INR paise — store as integers to avoid float drift)
  grossAmount: number;
  fee: number;
  tax: number;
  netAmount: number;
  currency: string;

  // Reconciliation
  status: SettlementStatus;
  matchedAt?: Date;
  mismatchReason?: string;
  expectedAmount?: number;
  diff?: number;

  // Source / batch info
  batchId?: string;
  reportSource?: 'razorpay_api' | 'csv_upload' | 'manual';
  settledAt?: Date;

  notes?: string;
  raw?: Record<string, any>;

  createdAt: Date;
  updatedAt: Date;
}

const settlementSchema = new Schema<ISettlement>(
  {
    razorpaySettlementId: { type: String, required: true, index: true },
    razorpayPaymentId: { type: String, index: true },
    razorpayOrderId: { type: String, index: true },
    utr: { type: String, index: true },

    payment: { type: Schema.Types.ObjectId, ref: 'Payment' },
    ride: { type: Schema.Types.ObjectId, ref: 'Ride' },

    grossAmount: { type: Number, required: true },
    fee: { type: Number, default: 0 },
    tax: { type: Number, default: 0 },
    netAmount: { type: Number, required: true },
    currency: { type: String, default: 'INR' },

    status: {
      type: String,
      enum: ['pending', 'matched', 'mismatch', 'failed', 'reconciled'],
      default: 'pending',
      index: true,
    },
    matchedAt: Date,
    mismatchReason: String,
    expectedAmount: Number,
    diff: Number,

    batchId: { type: String, index: true },
    reportSource: { type: String, enum: ['razorpay_api', 'csv_upload', 'manual'] },
    settledAt: Date,

    notes: String,
    raw: Schema.Types.Mixed,
  },
  { timestamps: true }
);

settlementSchema.index({ razorpaySettlementId: 1, razorpayPaymentId: 1 }, { unique: false });
settlementSchema.index({ status: 1, createdAt: -1 });
settlementSchema.index({ settledAt: -1 });

export const Settlement = mongoose.model<ISettlement>('Settlement', settlementSchema);
