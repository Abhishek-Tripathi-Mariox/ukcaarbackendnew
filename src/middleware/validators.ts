import { body } from 'express-validator';

export const sendOtpValidation = [
  body('phone')
    .notEmpty()
    .withMessage('Phone number is required')
    .matches(/^\+?[1-9]\d{1,14}$/)
    .withMessage('Invalid phone number format'),
  body('countryCode')
    .optional()
    .matches(/^\+\d{1,4}$/)
    .withMessage('Invalid country code'),
];

export const checkEligibilityValidation = [
  body('phone').notEmpty().withMessage('Phone number is required'),
  body('countryCode')
    .optional()
    .matches(/^\+\d{1,4}$/)
    .withMessage('Invalid country code'),
  body('appType').optional().isIn(['customer', 'driver']).withMessage('Invalid appType'),
];

export const firebaseLoginValidation = [
  body('idToken')
    .notEmpty()
    .withMessage('idToken is required')
    .isString()
    .withMessage('idToken must be a string'),
  body('appType')
    .optional()
    .isIn(['customer', 'driver'])
    .withMessage('Invalid appType'),
];

export const verifyOtpValidation = [
  body('phone').notEmpty().withMessage('Phone number is required'),
  body('otp')
    .notEmpty()
    .withMessage('OTP is required')
    .isLength({ min: 6, max: 6 })
    .withMessage('OTP must be 6 digits'),
];

export const updateProfileValidation = [
  body('firstName').optional().trim().isLength({ min: 1, max: 50 }),
  body('lastName').optional().trim().isLength({ min: 0, max: 50 }),
  body('email').optional({ values: 'falsy' }).isEmail().withMessage('Invalid email format'),
];

export const createRideValidation = [
  // rideType is now an admin-defined VehicleType.code, not a fixed enum.
  // We just enforce shape (non-empty slug) and let the dispatcher resolve
  // it against the live catalogue — unknown codes fall back to tier-only
  // filtering rather than rejecting the request outright.
  body('rideType')
    .notEmpty()
    .isString()
    .withMessage('rideType is required')
    .isLength({ max: 64 }),
  body('pickup.address').notEmpty().withMessage('Pickup address is required'),
  body('pickup.lat').isFloat({ min: -90, max: 90 }),
  body('pickup.lng').isFloat({ min: -180, max: 180 }),
  body('dropoff.address').notEmpty().withMessage('Dropoff address is required'),
  body('dropoff.lat').isFloat({ min: -90, max: 90 }),
  body('dropoff.lng').isFloat({ min: -180, max: 180 }),
  body('paymentMethod').optional().isIn(['card', 'cash', 'wallet']),
  // Optional real-route values from /geo/directions, so the booked ride keeps
  // the road distance/duration the rider was quoted instead of straight-line.
  body('distance').optional().isFloat({ min: 0 }),
  body('duration').optional().isFloat({ min: 0 }),
];

export const rateRideValidation = [
  body('rating')
    .isInt({ min: 1, max: 5 })
    .withMessage('Rating must be between 1 and 5'),
  body('comment').optional().trim().isLength({ max: 500 }),
  body('tags').optional().isArray(),
  body('tip').optional().isFloat({ min: 0 }),
];

export const driverSignupValidation = [
  body('firstName').notEmpty().trim(),
  body('lastName').notEmpty().trim(),
  body('email').isEmail(),
  body('phone').notEmpty(),
  body('licenceNumber').notEmpty(),
  body('vehicleMake').notEmpty(),
  body('vehicleModel').notEmpty(),
  body('vehicleYear').notEmpty(),
  body('vehicleColor').notEmpty(),
  body('plateNumber').notEmpty(),
];
