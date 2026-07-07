import dotenv from 'dotenv';
dotenv.config();

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '5000', 10),
  apiVersion: process.env.API_VERSION || 'v1',

  mongo: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/ukcaar',
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'fallback_secret',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'fallback_refresh_secret',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    // Set REDIS_ENABLED=true on EVERY backend instance to share Socket.IO
    // rooms + ride-dispatch state across them via Redis. Required whenever
    // more than one backend process serves the same DB (horizontal scaling,
    // or a customer-server / driver-server split). Leave unset for a single
    // instance — the app then uses in-process memory and needs no Redis.
    enabled: process.env.REDIS_ENABLED === 'true',
  },

  google: {
    mapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
  },

  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
  },

  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    phoneNumber: process.env.TWILIO_PHONE_NUMBER || '',
  },

  // ── OTP / auth (CLIENT-TESTING PHASE) ──
  // We have no SMS provider yet, so a universal OTP lets testers log in for
  // any phone number. SECURITY WARNING: while this is on, ANYONE who knows
  // `testOtp` can log into ANY account. This is a deliberate backdoor for the
  // pre-launch testing build. Set ALLOW_TEST_OTP=false (and ideally remove
  // this) before opening the apps to the public.
  auth: {
    allowTestOtp: process.env.ALLOW_TEST_OTP !== 'false', // ON by default for now
    testOtp: process.env.TEST_OTP || '115566',
  },

  upload: {
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '5242880', 10),
    dir: process.env.UPLOAD_DIR || 'uploads',
  },

  s3: {
    // NOTE: the real bucket is 'ukcar' (one 'a') in ap-south-1. The old
    // defaults ('ukcaar', 'eu-west-2') pointed at a bucket we don't own and
    // made every upload fail with AccessDenied when env vars were unset.
    bucketName: process.env.S3_BUCKET_NAME || 'ukcar',
    accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
    region: process.env.S3_REGION || 'ap-south-1',
    baseUrl: process.env.S3_BASE_URL || 'https://ukcar.s3.ap-south-1.amazonaws.com',
  },

  rateLimit: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
  },

  // ── Ride configuration ──
  ride: {
    searchRadiusKm: 5,
    maxWaitTimeSec: 30,
    cancellationFee: 5.0,
    minFare: 5.0,
    baseFares: {
      economy: { base: 3.0, perKm: 1.2, perMin: 0.15 },
      comfort: { base: 4.5, perKm: 1.6, perMin: 0.20 },
      premium: { base: 7.0, perKm: 2.2, perMin: 0.30 },
      xl: { base: 5.5, perKm: 1.8, perMin: 0.22 },
      electric: { base: 3.5, perKm: 1.4, perMin: 0.18 },
    },
    commissionRate: 0.20, // 20% platform commission
    onePassCommissionRate: 0.12, // 12% for One Pass subscribers
    surgeMultipliers: {
      low: 1.0,
      medium: 1.25,
      high: 1.5,
      veryHigh: 2.0,
    },
  },

  // ── Referrals ──
  // Wallet bonus credited to a user when they apply someone's referral code.
  // Defaults to 0 (linkage only) so money isn't given away by accident — set
  // REFERRAL_BONUS to enable. NOTE: crediting the *referrer* is intentionally
  // not done here; that should be gated on the referee's first completed ride
  // to limit abuse (a product decision).
  referral: {
    bonus: Number(process.env.REFERRAL_BONUS) || 0,
    currency: 'INR',
  },

  // ── OnePass subscription ──
  // Server-authoritative plans. The client never sends a price; it picks a
  // plan key and the backend charges the matching price via Razorpay.
  onePass: {
    price: 99.99,
    duration: 30, // days (legacy default)
    currency: 'INR',
    plans: {
      weekly: { label: 'Weekly', price: 49, days: 7 },
      monthly: { label: 'Monthly', price: 99.99, days: 30 },
      annual: { label: 'Annual', price: 999, days: 365 },
    } as Record<string, { label: string; price: number; days: number }>,
  },

  // ── Tax / invoicing (India) ──
  tax: {
    issuerName: process.env.INVOICE_ISSUER_NAME || 'UKCAAR Mobility Pvt Ltd',
    issuerGstin: process.env.INVOICE_ISSUER_GSTIN || '',
    issuerPan: process.env.INVOICE_ISSUER_PAN || '',
    issuerAddress: process.env.INVOICE_ISSUER_ADDRESS || '',
    issuerState: process.env.INVOICE_ISSUER_STATE || 'KA',
    // GST on cab booking service is generally 5% (without ITC) — split for intra-state
    gstRate: parseFloat(process.env.INVOICE_GST_RATE || '0.05'),
    cgstRate: parseFloat(process.env.INVOICE_CGST_RATE || '0.025'),
    sgstRate: parseFloat(process.env.INVOICE_SGST_RATE || '0.025'),
    igstRate: parseFloat(process.env.INVOICE_IGST_RATE || '0.05'),
    rideHsn: process.env.INVOICE_RIDE_HSN || '996412',
    // Section 194O — 1% TDS by ECO on payments to driver-partners (gross)
    tdsSection: process.env.TDS_SECTION || '194O',
    tdsRate: parseFloat(process.env.TDS_RATE || '0.01'),
    invoicePrefix: process.env.INVOICE_PREFIX || 'UKC',
  },

  nodeEnv: process.env.NODE_ENV || 'development',
} as const;

export default config;
