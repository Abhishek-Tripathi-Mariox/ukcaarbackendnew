import mongoose, { Document, Schema } from 'mongoose';
import bcrypt from 'bcryptjs';
import { ADMIN_ROLES, AdminRole, Permission } from '../config/permissions';

export interface IUser extends Document {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  countryCode: string;
  password?: string;
  avatar?: string;
  role: 'customer' | 'driver' | 'admin';
  /** Admin sub-role. Only meaningful when role === 'admin'. */
  adminRole?: AdminRole;
  /** Optional permission overrides on top of the role defaults. */
  adminPermissions?: Permission[];
  /** Who invited this admin (audit). */
  invitedBy?: mongoose.Types.ObjectId;
  invitedAt?: Date;
  lastLoginAt?: Date;
  lastLoginIp?: string;
  disabledAt?: Date;
  disabledReason?: string;
  isVerified: boolean;
  isActive: boolean;
  /** Date of birth — captured on the driver registration's "complete profile" step. */
  dob?: Date;
  otp?: string;
  otpExpiry?: Date;
  refreshToken?: string;

  // Customer-specific
  savedAddresses?: {
    label: string;
    address: string;
    lat: number;
    lng: number;
    icon: string;
    isPrimary?: boolean;
    houseNo?: string;
    apartment?: string;
    landmark?: string;
    city?: string;
    state?: string;
    pincode?: string;
  }[];

  // Driver-specific
  driverProfile?: {
    licenceNumber: string;
    vehicleMake: string;
    vehicleModel: string;
    vehicleYear: string;
    vehicleColor: string;
    plateNumber: string;
    insuranceNumber: string;
    /** When their insurance expires — captured as a date on the registration form. */
    insuranceExpiry?: Date;
    /** When their driving license expires — captured on the driver-details step. */
    licenceExpiry?: Date;
    /** How many years they've been driving — driver-details step. */
    yearsExperience?: number;
    /**
     * Code (slug) referring to a VehicleType document. Stored as a string
     * code, not an ObjectId, so deletes on the admin side don't orphan
     * driver records — the historical type is preserved.
     */
    vehicleTypeCode?: string;
    /** Code (slug) referring to a FuelType document. Same rationale as vehicleTypeCode. */
    fuelTypeCode?: string;
    /**
     * Vehicle owner details. The driver might not own the car they drive
     * (fleet, family vehicle), so we capture this separately. When the
     * driver is the owner, the registration form pre-fills these from
     * their account.
     */
    ownerName?: string;
    ownerContact?: string;
    ownerAddress?: string;
    /** Driver's chosen primary service: instant / private / scheduled. */
    serviceType?: 'instant' | 'private' | 'scheduled';
    /**
     * Where the driver is in the registration funnel. Lets the app resume
     * registration on relogin instead of restarting from scratch. `null`
     * means they haven't started; `'approved'` means fully onboarded and
     * the app should send them to the dashboard.
     */
    registrationStep?:
      | 'service-type'
      | 'vehicle-details'
      | 'owner-details'
      | 'driver-details'
      | 'complete-profile'
      | 'pending'
      | 'approved'
      | 'rejected';
    isOnline: boolean;
    currentLocation?: { lat: number; lng: number };
    rating: number;
    totalTrips: number;
    totalEarnings: number;
    commissionRate?: number;
    isOnePass: boolean;
    onePassExpiry?: Date;
    documents: {
      type: string;
      url: string;
      status: 'pending' | 'verified' | 'rejected';
      expiry?: Date;
    }[];
    /**
     * Bank details captured on the "complete profile" step. Used for payouts.
     * Optional because not every driver type needs it, and we keep the rest
     * of the profile saving flow tolerant if these aren't filled in yet.
     */
    bankDetails?: {
      accountHolder?: string;
      bankName?: string;
      accountNumber?: string;
      ifsc?: string;
      passbookUrl?: string;
    };
  };

  isProfileSetup: boolean;
  language: string;
  pushToken?: string;
  fcmTokens: { token: string; platform: 'ios' | 'android'; updatedAt: Date }[];
  createdAt: Date;
  updatedAt: Date;

  comparePassword(candidatePassword: string): Promise<boolean>;
  fullName: string;
}

const userSchema = new Schema<IUser>(
  {
    firstName: { type: String, default: '', trim: true },
    lastName: { type: String, default: '', trim: true },
    email: {
      type: String,
      default: '',
      lowercase: true,
      trim: true,
    },
    phone: { type: String, required: true, unique: true },
    countryCode: { type: String, default: '+44' },
    password: { type: String, select: false },
    avatar: { type: String },
    role: {
      type: String,
      enum: ['customer', 'driver', 'admin'],
      default: 'customer',
    },
    adminRole: {
      type: String,
      enum: ADMIN_ROLES,
      required: false,
    },
    adminPermissions: {
      type: [String],
      default: undefined,
    },
    invitedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    invitedAt: { type: Date },
    lastLoginAt: { type: Date },
    lastLoginIp: { type: String },
    disabledAt: { type: Date },
    disabledReason: { type: String },
    isVerified: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    dob: { type: Date },
    otp: { type: String, select: false },
    otpExpiry: { type: Date, select: false },
    refreshToken: { type: String, select: false },

    savedAddresses: [
      {
        label: String,
        address: String,
        lat: Number,
        lng: Number,
        icon: { type: String, default: 'location' },
        isPrimary: { type: Boolean, default: false },
        houseNo: String,
        apartment: String,
        landmark: String,
        city: String,
        state: String,
        pincode: String,
      },
    ],

    driverProfile: {
      licenceNumber: String,
      licenceExpiry: Date,
      yearsExperience: Number,
      vehicleMake: String,
      vehicleModel: String,
      vehicleYear: String,
      vehicleColor: String,
      plateNumber: String,
      insuranceNumber: String,
      insuranceExpiry: Date,
      vehicleTypeCode: { type: String, lowercase: true, trim: true },
      fuelTypeCode: { type: String, lowercase: true, trim: true },
      ownerName: { type: String, trim: true },
      ownerContact: { type: String, trim: true },
      ownerAddress: { type: String, trim: true },
      serviceType: {
        type: String,
        enum: ['instant', 'private', 'scheduled'],
      },
      registrationStep: {
        type: String,
        enum: [
          'service-type',
          'vehicle-details',
          'owner-details',
          'driver-details',
          'complete-profile',
          'pending',
          'approved',
          'rejected',
        ],
      },
      isOnline: { type: Boolean, default: false },
      currentLocation: {
        lat: Number,
        lng: Number,
      },
      rating: { type: Number, default: 5.0 },
      totalTrips: { type: Number, default: 0 },
      totalEarnings: { type: Number, default: 0 },
      commissionRate: { type: Number, min: 0, max: 100, default: undefined },
      isOnePass: { type: Boolean, default: false },
      onePassExpiry: Date,
      documents: [
        {
          type: { type: String },
          url: String,
          status: {
            type: String,
            enum: ['pending', 'verified', 'rejected'],
            default: 'pending',
          },
          expiry: Date,
        },
      ],
      bankDetails: {
        accountHolder: String,
        bankName: String,
        accountNumber: String,
        ifsc: String,
        passbookUrl: String,
      },
    },

    isProfileSetup: { type: Boolean, default: false },
    language: { type: String, default: 'en' },
    pushToken: { type: String },
    fcmTokens: {
      type: [
        {
          token: { type: String, required: true },
          platform: { type: String, enum: ['ios', 'android'], required: true },
          updatedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ── Indexes for performance at scale ──
// Sparse unique on email: allows multiple users with empty/null email
userSchema.index({ email: 1 }, { unique: true, sparse: true });
userSchema.index({ role: 1, isActive: 1 });
userSchema.index({ 'driverProfile.isOnline': 1, 'driverProfile.currentLocation': '2dsphere' });

// ── Virtual for full name ──
userSchema.virtual('fullName').get(function (this: IUser) {
  return `${this.firstName} ${this.lastName}`;
});

// ── Hash password before saving ──
userSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) return next();
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// ── Compare password ──
userSchema.methods.comparePassword = async function (
  candidatePassword: string
): Promise<boolean> {
  if (!this.password) return false;
  return bcrypt.compare(candidatePassword, this.password);
};

export const User = mongoose.model<IUser>('User', userSchema);
