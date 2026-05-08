import { Schema, model, Document, Types } from 'mongoose';

/**
 * Schedule-based surge rule. Multiple rules may match a given (lat, lng, time);
 * the highest-priority active rule (then highest multiplier) wins.
 *
 * Time window is expressed in local server time:
 *   - daysOfWeek: 0=Sun … 6=Sat
 *   - startMinute / endMinute: minutes since 00:00 (0..1440)
 * If startMinute > endMinute the window wraps past midnight.
 *
 * Optional zone scope: when `zone` is set, the rule only fires for pickups
 * inside that zone. When omitted, the rule applies platform-wide.
 *
 * Optional date range: when set, the rule only fires on/between those dates
 * (inclusive). Useful for special events / holidays.
 */
export interface ISurgeRule extends Document {
  _id: Types.ObjectId;
  name: string;
  description?: string;
  zone?: Types.ObjectId;
  daysOfWeek: number[];
  startMinute: number;
  endMinute: number;
  multiplier: number;
  flatSurcharge: number;
  priority: number;
  isActive: boolean;
  startDate?: Date;
  endDate?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const surgeRuleSchema = new Schema<ISurgeRule>(
  {
    name: { type: String, required: true, trim: true },
    description: String,
    zone: { type: Schema.Types.ObjectId, ref: 'Zone', index: true },
    daysOfWeek: {
      type: [Number],
      default: [0, 1, 2, 3, 4, 5, 6],
      validate: (v: number[]) => v.every((d) => d >= 0 && d <= 6),
    },
    startMinute: { type: Number, default: 0, min: 0, max: 1440 },
    endMinute: { type: Number, default: 1440, min: 0, max: 1440 },
    multiplier: { type: Number, default: 1, min: 0.5, max: 5 },
    flatSurcharge: { type: Number, default: 0, min: 0 },
    priority: { type: Number, default: 0, index: true },
    isActive: { type: Boolean, default: true, index: true },
    startDate: Date,
    endDate: Date,
  },
  { timestamps: true }
);

export const SurgeRule = model<ISurgeRule>('SurgeRule', surgeRuleSchema);
