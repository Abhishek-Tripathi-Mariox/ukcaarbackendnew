import mongoose, { Document, Schema } from 'mongoose';

/**
 * Singleton document holding admin-overridable platform settings that used
 * to live (hard-coded) in `config.ride`. Exactly one document ever exists,
 * keyed by the fixed string 'platform'.
 *
 * Why a collection and not just config: the admin Fare Calculation page needs
 * to change the platform commission and cancellation fee at runtime and have
 * those values take effect on the very next ride settlement — without a code
 * change or redeploy. Reads fall back to the `config.ride` defaults for any
 * field left unset, so partial configuration is safe.
 */
export interface ISettings extends Document {
  key: string; // always 'platform'
  /** Platform commission as a fraction in [0, 1] (e.g. 0.2 = 20%). */
  commissionRate?: number;
  /** Reduced commission fraction for OnePass drivers. */
  onePassCommissionRate?: number;
  /** Flat fee (₹) charged when a ride is cancelled after the free window. */
  cancellationFee?: number;
  /** Global minimum billable fare (₹). */
  minFare?: number;

  // ── General app settings (admin Settings → General tab) ──
  /** Display name of the platform. */
  appName?: string;
  /** Support contact email shown to users. */
  supportEmail?: string;
  /** Support contact phone shown to users. */
  supportPhone?: string;
  /** Max driver-search radius in km. */
  maxSearchRadius?: number;
  /** Seconds a ride request waits for a driver before timing out. */
  driverTimeout?: number;
  /** When true, the platform is flagged as under maintenance. */
  maintenanceMode?: boolean;
  /** Wallet bonus (₹) credited when a user applies a referral code. */
  referralBonus?: number;

  updatedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const settingsSchema = new Schema<ISettings>(
  {
    key: { type: String, required: true, unique: true, default: 'platform' },
    commissionRate: { type: Number, min: 0, max: 1 },
    onePassCommissionRate: { type: Number, min: 0, max: 1 },
    cancellationFee: { type: Number, min: 0 },
    minFare: { type: Number, min: 0 },
    appName: { type: String, trim: true },
    supportEmail: { type: String, trim: true },
    supportPhone: { type: String, trim: true },
    maxSearchRadius: { type: Number, min: 1, max: 50 },
    driverTimeout: { type: Number, min: 10, max: 120 },
    maintenanceMode: { type: Boolean },
    referralBonus: { type: Number, min: 0 },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export const Settings = mongoose.model<ISettings>('Settings', settingsSchema);
