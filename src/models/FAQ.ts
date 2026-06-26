import mongoose, { Schema, Document } from 'mongoose';

/**
 * Admin-managed FAQ entry surfaced in the customer and driver apps' Help &
 * Support screens. `audience` controls which app(s) an entry shows in:
 *
 *   - 'user'   → customer app only
 *   - 'driver' → driver app only
 *   - 'both'   → shown in both apps
 *
 * The apps fetch active entries for their role (customer → user+both,
 * driver → driver+both) via GET /support/faqs, sorted by `order` ascending.
 */
export type FaqAudience = 'user' | 'driver' | 'both';

export interface IFAQ extends Document {
  question: string;
  answer: string;
  audience: FaqAudience;
  isActive: boolean;
  /** Manual display order (ascending). Ties broken by createdAt. */
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

const faqSchema = new Schema<IFAQ>(
  {
    question: { type: String, required: true, trim: true },
    answer: { type: String, required: true, trim: true },
    audience: {
      type: String,
      enum: ['user', 'driver', 'both'],
      default: 'both',
      index: true,
    },
    isActive: { type: Boolean, default: true, index: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// Customer/driver lookup filters on (audience, isActive) and sorts by order.
faqSchema.index({ audience: 1, isActive: 1, order: 1 });

export const FAQ = mongoose.model<IFAQ>('FAQ', faqSchema);
