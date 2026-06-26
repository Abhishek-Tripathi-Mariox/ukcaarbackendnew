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
  /**
   * Indian 6-digit postal code captured from the autocomplete suggestion
   * when the admin picked this stop. The customer scheduled-route lookup
   * matches a rider's pincode against this field FIRST (more reliable
   * than parsing the address string, which doesn't always contain a PIN
   * — e.g. "Aligarh, Uttar Pradesh, India" has no PIN). Falls back to
   * parsing `address` for legacy stops saved before this field existed.
   */
  pincode?: string;
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
  returnDepartures?: IRouteDeparture[];   // optional return-leg times
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
  /**
   * Which departure slot the driver signed up for (index into
   * `schedule.departures`). Required for scheduled routes; ignored for
   * private routes.
   */
  departureIndex?: number;
  /**
   * If true, the driver also runs the return leg of this route at the
   * matching return departure time. Used for routes where customers can
   * book the same driver for the back-trip (e.g. airport shuttles where
   * passengers fly out and back the same day with the same driver).
   */
  roundTrip?: boolean;
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
    pincode: {
      type: String,
      trim: true,
      // Only validate when actually set — legacy stops carry no PIN.
      match: /^\d{4,10}$/,
    },
  },
  { _id: false }
);

// Index pincode for fast customer-side route lookup by rider PIN.
// MongoDB indexes subdoc array fields fine when accessed with `$elemMatch`
// or dot notation, which is exactly how listScheduledRoutes queries.
stopSchema.index({ pincode: 1 });

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
    returnDepartures: { type: [departureSchema], default: undefined },
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
    departureIndex: { type: Number, min: 0 },
    roundTrip: { type: Boolean, default: false },
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
