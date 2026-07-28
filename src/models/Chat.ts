import mongoose, { Document, Schema } from 'mongoose';

export interface IChat extends Document {
  ride: mongoose.Types.ObjectId;
  participants: mongoose.Types.ObjectId[];
  messages: {
    sender: mongoose.Types.ObjectId;
    content: string;
    type: 'text' | 'image' | 'location';
    read: boolean;
    createdAt: Date;
  }[];
  createdAt: Date;
  updatedAt: Date;
}

const chatSchema = new Schema<IChat>(
  {
    ride: { type: Schema.Types.ObjectId, ref: 'Ride', required: true },
    participants: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    messages: [
      {
        sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
        content: { type: String, required: true },
        type: { type: String, enum: ['text', 'image', 'location'], default: 'text' },
        read: { type: Boolean, default: false },
        createdAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

chatSchema.index({ ride: 1 });
chatSchema.index({ participants: 1 });

export const Chat = mongoose.model<IChat>('Chat', chatSchema);


// ── Promo Code Model ──
export interface IPromoCode extends Document {
  code: string;
  type: 'percentage' | 'fixed';
  value: number;
  maxUses: number;
  usedCount: number;
  minFare: number;
  maxDiscount: number;
  expiresAt: Date;
  isActive: boolean;
  description?: string;
  maxUsesPerUser?: number;
  createdAt: Date;
}

const promoCodeSchema = new Schema<IPromoCode>(
  {
    code: { type: String, required: true, unique: true, uppercase: true },
    type: { type: String, enum: ['percentage', 'fixed'], required: true },
    value: { type: Number, required: true, min: 0 },
    description: { type: String, trim: true },
    maxUses: { type: Number, default: 100 },
    /** Per-customer redemption limit. Unset = unlimited. */
    maxUsesPerUser: { type: Number, min: 1 },
    usedCount: { type: Number, default: 0 },
    minFare: { type: Number, default: 0 },
    // No default: an absent maxDiscount means NO CAP. The old default of 50
    // silently capped every promo (a "Rs.100 off" fixed promo paid out Rs.50).
    maxDiscount: { type: Number, min: 0 },
    expiresAt: { type: Date, required: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Note: code already has unique index from schema definition

export const PromoCode = mongoose.model<IPromoCode>('PromoCode', promoCodeSchema);
