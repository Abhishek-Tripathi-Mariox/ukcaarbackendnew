import mongoose, { Document, Schema } from 'mongoose';

/**
 * A vehicle type the driver can register their vehicle as. Managed by
 * admins (CRUD via /api/v1/admin/vehicle-types). The driver app pulls the
 * active list via /api/v1/vehicle-types and renders it as a dropdown.
 *
 * `code` is a stable machine-friendly id (slug) so other parts of the
 * system can reference a type without depending on display-name spelling.
 */
export interface IVehicleType extends Document {
  name: string;
  code: string;
  description?: string;
  isActive: boolean;
  sortOrder: number;
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
  },
  { timestamps: true }
);

vehicleTypeSchema.index({ isActive: 1, sortOrder: 1 });

export const VehicleType = mongoose.model<IVehicleType>(
  'VehicleType',
  vehicleTypeSchema
);
