import { Schema, model, Document, Types } from 'mongoose';

export type ZoneKind = 'surge' | 'no_pickup' | 'airport' | 'city' | 'restricted';

/**
 * A geographic zone defined as a GeoJSON Polygon (or MultiPolygon).
 * Used for:
 *  - Static surge multipliers attached to a zone
 *  - No-pickup / restricted areas (rides may not start here)
 *  - Airport / city tagging (analytics & special pricing)
 *
 * Polygon coordinates follow GeoJSON spec: [lng, lat], outer ring closed.
 */
export interface IZone extends Document {
  _id: Types.ObjectId;
  name: string;
  kind: ZoneKind;
  description?: string;
  color?: string;                 // hex for UI display
  isActive: boolean;
  /** Static multiplier applied when a ride pickup lies in this zone (only used for kind='surge'). */
  surgeMultiplier: number;
  /** Optional flat surcharge added on top, e.g. ₹2 airport pickup fee. */
  flatSurcharge: number;
  geometry: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: number[][][] | number[][][][];
  };
  createdAt: Date;
  updatedAt: Date;
}

const zoneSchema = new Schema<IZone>(
  {
    name: { type: String, required: true, trim: true },
    kind: {
      type: String,
      enum: ['surge', 'no_pickup', 'airport', 'city', 'restricted'],
      required: true,
      index: true,
    },
    description: String,
    color: { type: String, default: '#3b82f6' },
    isActive: { type: Boolean, default: true, index: true },
    surgeMultiplier: { type: Number, default: 1, min: 0.5, max: 5 },
    flatSurcharge: { type: Number, default: 0, min: 0 },
    geometry: {
      type: {
        type: String,
        enum: ['Polygon', 'MultiPolygon'],
        required: true,
      },
      coordinates: { type: Schema.Types.Mixed, required: true },
    },
  },
  { timestamps: true }
);

// 2dsphere index for $geoIntersects point-in-polygon queries
zoneSchema.index({ geometry: '2dsphere' });

export const Zone = model<IZone>('Zone', zoneSchema);
