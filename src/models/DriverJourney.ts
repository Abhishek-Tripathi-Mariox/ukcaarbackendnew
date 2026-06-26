import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * Runtime state for one driver's scheduled-shuttle trip on a
 * (route, departureIndex, departureDate). Bookings carry the passenger
 * manifest; this document tracks the *operation* of the trip — started,
 * which stop the shuttle is at, completed, and the settled earnings.
 *
 * Created lazily the first time the driver opens/starts the journey
 * (resolveOrCreate by the composite key). Uniqueness is enforced by the
 * compound index so a trip can never have two journey docs.
 */
export type JourneyStatus = 'scheduled' | 'active' | 'in_progress' | 'completed' | 'cancelled';

export interface IDriverJourney extends Document {
  _id: Types.ObjectId;
  route: Types.ObjectId;
  driver: Types.ObjectId;
  departureIndex: number;
  departureDate: string; // YYYY-MM-DD
  status: JourneyStatus;
  /** Index into Route.stops the shuttle is currently at. */
  currentStopIndex: number;
  startedAt?: Date;
  completedAt?: Date;
  /** Driver earnings settled on completion. */
  earnings?: number;
  createdAt: Date;
  updatedAt: Date;
}

const driverJourneySchema = new Schema<IDriverJourney>(
  {
    route: { type: Schema.Types.ObjectId, ref: 'Route', required: true },
    driver: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    departureIndex: { type: Number, required: true, min: 0 },
    departureDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    status: {
      type: String,
      enum: ['scheduled', 'active', 'in_progress', 'completed', 'cancelled'],
      default: 'scheduled',
      index: true,
    },
    currentStopIndex: { type: Number, default: 0, min: 0 },
    startedAt: Date,
    completedAt: Date,
    earnings: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

// One journey doc per (route, driver, departure slot, date).
driverJourneySchema.index(
  { route: 1, driver: 1, departureIndex: 1, departureDate: 1 },
  { unique: true },
);

export const DriverJourney = mongoose.model<IDriverJourney>(
  'DriverJourney',
  driverJourneySchema,
);
