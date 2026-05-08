import { Schema, model, Document, Types } from 'mongoose';

export type RouteType = 'private' | 'scheduled';
export type RouteDriverStatus = 'pending' | 'approved' | 'rejected' | 'removed';

/**
 * Admin-defined route used by the Private and Scheduled (shuttle) ride
 * products. Drivers register against a route with one of their vehicles;
 * customers can book if their pickup AND drop fall within `corridorBufferMeters`
 * of any stop or segment of the route.
 *
 *  - `private`   → only `assignedUsers` can see/book; admin curates both
 *                  the eligible drivers and the eligible customers.
 *  - `scheduled` → fixed shuttle route with departure times; any customer
 *                  whose pickup/drop sits near the corridor can reserve a seat.
 */
export interface IRouteStop {
  name: string;
  address?: string;
  lat: number;
  lng: number;
  sequence: number;
  /**
   * Fare (in GBP) charged for the segment FROM the previous stop TO this
   * stop. Ignored on the first stop. Total fare from stop A (index i) to
   * stop B (index j>i) = sum of `fareFromPrevious` for stops i+1..j.
   */
  fareFromPrevious?: number;
}

export interface IRouteDeparture {
  /** Index into the `stops` array indicating where this departure starts. */
  stopIndex: number;
  /** Local time in HH:mm format (24h). */
  time: string;
}

export interface IRouteSchedule {
  /** 0 = Sunday, 6 = Saturday. */
  daysOfWeek: number[];
  departures: IRouteDeparture[];
  seatPrice: number;
  vehicleType?: string; // e.g. 'shuttle', 'sedan'
  totalSeats?: number;
}

export interface IRouteDriverRegistration {
  driver: Types.ObjectId;
  vehicle?: Types.ObjectId;
  status: RouteDriverStatus;
  registeredAt: Date;
  approvedAt?: Date;
  approvedBy?: Types.ObjectId;
  note?: string;
}

export interface IRoute extends Document {
  _id: Types.ObjectId;
  name: string;
  description?: string;
  type: RouteType;
  isActive: boolean;
  /** Ordered list of waypoints / stops. */
  stops: IRouteStop[];
  /** Match radius (in meters) used to decide if a customer's pickup/drop is "on" this route. */
  corridorBufferMeters: number;
  /** Schedule information for scheduled (shuttle) routes. */
  schedule?: IRouteSchedule;
  /** Customers explicitly assigned to a private route. */
  assignedUsers: Types.ObjectId[];
  /** Drivers who registered (and may operate) this route. */
  registeredDrivers: IRouteDriverRegistration[];
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const stopSchema = new Schema<IRouteStop>(
  {
    name: { type: String, required: true, trim: true },
    address: { type: String, trim: true },
    lat: { type: Number, required: true, min: -90, max: 90 },
    lng: { type: Number, required: true, min: -180, max: 180 },
    sequence: { type: Number, required: true, min: 0 },
    fareFromPrevious: { type: Number, min: 0, default: 0 },
  },
  { _id: false }
);

const departureSchema = new Schema<IRouteDeparture>(
  {
    stopIndex: { type: Number, required: true, min: 0 },
    time: {
      type: String,
      required: true,
      match: /^([01]\d|2[0-3]):[0-5]\d$/,
    },
  },
  { _id: false }
);

const scheduleSchema = new Schema<IRouteSchedule>(
  {
    daysOfWeek: { type: [Number], default: [] },
    departures: { type: [departureSchema], default: [] },
    seatPrice: { type: Number, default: 0, min: 0 },
    vehicleType: { type: String, trim: true },
    totalSeats: { type: Number, min: 1 },
  },
  { _id: false }
);

const driverRegistrationSchema = new Schema<IRouteDriverRegistration>(
  {
    driver: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    vehicle: { type: Schema.Types.ObjectId, ref: 'Vehicle' },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'removed'],
      default: 'pending',
      index: true,
    },
    registeredAt: { type: Date, default: () => new Date() },
    approvedAt: Date,
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    note: String,
  },
  { _id: false }
);

const routeSchema = new Schema<IRoute>(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    type: {
      type: String,
      enum: ['private', 'scheduled'],
      required: true,
      index: true,
    },
    isActive: { type: Boolean, default: true, index: true },
    stops: {
      type: [stopSchema],
      validate: {
        validator: (v: IRouteStop[]) => Array.isArray(v) && v.length >= 2,
        message: 'A route must have at least two stops',
      },
    },
    corridorBufferMeters: { type: Number, default: 1500, min: 0, max: 50000 },
    schedule: { type: scheduleSchema },
    assignedUsers: [{ type: Schema.Types.ObjectId, ref: 'User', index: true }],
    registeredDrivers: { type: [driverRegistrationSchema], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

routeSchema.index({ type: 1, isActive: 1 });
routeSchema.index({ 'registeredDrivers.driver': 1, 'registeredDrivers.status': 1 });

export const Route = model<IRoute>('Route', routeSchema);
