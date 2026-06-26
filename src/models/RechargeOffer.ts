import mongoose, { Document, Schema } from 'mongoose';

/**
 * Admin-managed wallet recharge offer surfaced on the customer app's
 * "Recharge Wallet" screen. Each offer is a fixed denomination the rider
 * can tap to top up, optionally sweetened two ways:
 *
 *   - bonusAmount    : extra credit added to the wallet on top of the
 *                      denomination ("Get ₹50 Extra"). Pay for ₹500, ₹550
 *                      lands in the wallet.
 *   - discountPercent: a percentage knocked off the payable price. The rider
 *                      still gets the full denomination (+ bonus) credited but
 *                      pays less for it.
 *
 * The customer app reads active offers via GET /payments/recharge-offers,
 * sorted by `order` ascending. The actual payable/credit math is computed
 * server-side in the payment controller (single source of truth) — never
 * trust client-sent amounts for offer top-ups.
 */
export interface IRechargeOffer extends Document {
  /** Recharge denomination, in INR. This much (plus bonus) is credited. */
  amount: number;
  /** Extra wallet credit added on top of `amount`. */
  bonusAmount: number;
  /** Percentage discount applied to the payable price (0–100). */
  discountPercent: number;
  /** Optional override for the gold-strip label (defaults to "Get ₹X Extra"). */
  label?: string;
  /** Highlights the tile with the "Most Popular" badge. Only one should be set. */
  isPopular: boolean;
  isActive: boolean;
  /** Manual display order (ascending). Ties broken by amount. */
  order: number;
  /** Optional scheduling window — offer only shows between these dates. */
  validFrom?: Date;
  validUntil?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const rechargeOfferSchema = new Schema<IRechargeOffer>(
  {
    amount: { type: Number, required: true, min: 1 },
    bonusAmount: { type: Number, default: 0, min: 0 },
    discountPercent: { type: Number, default: 0, min: 0, max: 100 },
    label: { type: String, trim: true },
    isPopular: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true, index: true },
    order: { type: Number, default: 0 },
    validFrom: { type: Date },
    validUntil: { type: Date },
  },
  { timestamps: true },
);

// Customer lookup filters on isActive and sorts by order, then amount.
rechargeOfferSchema.index({ isActive: 1, order: 1, amount: 1 });

export const RechargeOffer = mongoose.model<IRechargeOffer>(
  'RechargeOffer',
  rechargeOfferSchema,
);
