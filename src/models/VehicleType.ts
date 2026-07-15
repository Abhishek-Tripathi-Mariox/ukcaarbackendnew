import mongoose, { Document, Schema } from 'mongoose';

/**
 * A vehicle type the driver can register their vehicle as. Managed by
 * admins (CRUD via /api/v1/admin/vehicle-types). The driver app pulls the
 * active list via /api/v1/vehicle-types and renders it as a dropdown.
 *
 * `code` is a stable machine-friendly id (slug) so other parts of the
 * system can reference a type without depending on display-name spelling.
 */
/**
 * Service tier this vehicle type belongs to.
 *   instant — everyday rides (Mini, Sedan, Bike, Auto). Wide audience.
 *   private — premium rides (think Uber Black). Pricier, vetted drivers.
 *
 * The customer app shows two tabs ("Instant" vs "Private") and lists only
 * the types that match the active tab. Drivers are also filtered by their
 * registered serviceType against this tier when dispatching.
 */
export type VehicleTier = 'instant' | 'private';

/**
 * How fares are computed for this vehicle type:
 *   per_km       — distance-based: base + perKm·km + perMin·min (default).
 *   subscription — flat fare per ride regardless of distance/time. Used for
 *                  two- and three-wheelers (bike/auto). The rider always pays
 *                  `flatFare`; surge does not apply.
 */
export type FarePricingModel = 'per_km' | 'subscription';

export interface IVehicleType extends Document {
  name: string;
  code: string;
  description?: string;
  isActive: boolean;
  sortOrder: number;
  tier: VehicleTier;
  /** Pricing model — distance-based or flat subscription fare. */
  pricingModel: FarePricingModel;
  /** Flat fare (₹) charged per ride when pricingModel === 'subscription'. */
  flatFare?: number;
  // Admin-configurable pricing. Both customer-side fare estimation and
  // ride creation look these up by code first; if a type doesn't have its
  // own values yet, we fall back to the legacy `config.ride.baseFares`
  // table so existing rides keep pricing correctly during the migration.
  //   baseFare    — flat boarding charge (₹).
  //   perKmFare   — distance multiplier (₹/km).
  //   perMinFare  — duration multiplier (₹/min).
  //   minFare     — minimum the rider pays no matter what; protects the
  //                 driver on ultra-short trips.
  baseFare?: number;
  perKmFare?: number;
  perMinFare?: number;
  minFare?: number;
  /** Passenger seat capacity for this vehicle type (excludes the driver).
   *  Shown on the customer SelectRide screen ("N Seats"). When unset, the
   *  customer app falls back to a code-based heuristic, so existing types
   *  keep working until an admin fills this in. */
  seats?: number;
  createdAt: Date;
  updatedAt: Date;
}

const vehicleTypeSchema = new Schema<IVehicleType>(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true, lowercase: true, unique: true },
    description: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    tier: {
      type: String,
      enum: ['instant', 'private'],
      default: 'instant',
      index: true,
    },
    pricingModel: {
      type: String,
      enum: ['per_km', 'subscription'],
      default: 'per_km',
      index: true,
    },
    flatFare: { type: Number, min: 0 },
    baseFare: { type: Number, min: 0 },
    perKmFare: { type: Number, min: 0 },
    perMinFare: { type: Number, min: 0 },
    minFare: { type: Number, min: 0 },
    seats: { type: Number, min: 1, max: 60 },
  },
  { timestamps: true }
);

vehicleTypeSchema.index({ isActive: 1, sortOrder: 1 });

export const VehicleType = mongoose.model<IVehicleType>(
  'VehicleType',
  vehicleTypeSchema
);
