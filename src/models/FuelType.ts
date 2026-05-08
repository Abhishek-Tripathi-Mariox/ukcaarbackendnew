import mongoose, { Document, Schema } from 'mongoose';

/**
 * Fuel type the driver's vehicle runs on. Independent of VehicleType —
 * driver picks both separately on the vehicle-details registration screen.
 */
export interface IFuelType extends Document {
  name: string;
  code: string;
  description?: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

const fuelTypeSchema = new Schema<IFuelType>(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true, lowercase: true, unique: true },
    description: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

fuelTypeSchema.index({ isActive: 1, sortOrder: 1 });

export const FuelType = mongoose.model<IFuelType>('FuelType', fuelTypeSchema);
