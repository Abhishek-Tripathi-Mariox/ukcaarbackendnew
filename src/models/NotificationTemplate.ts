import mongoose, { Schema, Document } from 'mongoose';

export type NotificationChannel = 'push' | 'inapp' | 'both';
export type NotificationTemplateType = 'ride' | 'payment' | 'promo' | 'safety' | 'system';

export interface INotificationTemplate extends Document {
  /** Stable identifier referenced from code, e.g. "ride.accepted", "payment.success". */
  key: string;
  name: string;
  description?: string;
  type: NotificationTemplateType;
  channel: NotificationChannel;
  /** ISO language tag, e.g. "en", "hi". Defaults to "en". */
  locale: string;
  /** Mustache-style title with {{var}} placeholders. */
  titleTemplate: string;
  /** Mustache-style body with {{var}} placeholders. */
  bodyTemplate: string;
  /** Default values merged under runtime variables. */
  defaultData?: Record<string, any>;
  /** Names of variables this template expects (for the admin UI). */
  variables?: string[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const notificationTemplateSchema = new Schema<INotificationTemplate>(
  {
    key: { type: String, required: true, trim: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    type: {
      type: String,
      enum: ['ride', 'payment', 'promo', 'safety', 'system'],
      default: 'system',
    },
    channel: { type: String, enum: ['push', 'inapp', 'both'], default: 'both' },
    locale: { type: String, default: 'en', index: true },
    titleTemplate: { type: String, required: true },
    bodyTemplate: { type: String, required: true },
    defaultData: { type: Schema.Types.Mixed, default: {} },
    variables: { type: [String], default: [] },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

// Unique per (key, locale) — allows i18n variants of the same template key.
notificationTemplateSchema.index({ key: 1, locale: 1 }, { unique: true });

export const NotificationTemplate = mongoose.model<INotificationTemplate>(
  'NotificationTemplate',
  notificationTemplateSchema,
);
