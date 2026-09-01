import { Router } from 'express';
import {
  sendOtp,
  verifyOtp,
  firebaseLogin,
  checkAppEligibility,
  refreshToken,
  logout,
  getMe,
  applyReferral,
  deleteAccount,
  updateProfile,
  driverSignup,
  adminLogin,
  forgotPassword,
  resetPassword,
  changePassword,
} from '../controllers/authController';
import { authenticate } from '../middleware/auth';
import {
  sendOtpValidation,
  verifyOtpValidation,
  firebaseLoginValidation,
  checkEligibilityValidation,
  updateProfileValidation,
  driverSignupValidation,
} from '../middleware/validators';

const router = Router();

// ── Public ──
// Firebase phone sign-in (replaces send-otp/verify-otp — those stay only
// until both apps ship the new flow, then delete them and the OTP fields).
// Pre-flight: lets the app refuse a wrong-app/suspended number BEFORE
// Firebase sends a billable SMS.
router.post('/check-eligibility', checkEligibilityValidation, checkAppEligibility);
router.post('/firebase-login', firebaseLoginValidation, firebaseLogin);
router.post('/send-otp', sendOtpValidation, sendOtp);
router.post('/verify-otp', verifyOtpValidation, verifyOtp);
router.post('/refresh-token', refreshToken);
router.post('/driver-signup', driverSignupValidation, driverSignup);
// Admin email/password login
router.post('/login', adminLogin);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);

// ── Protected ──
router.get('/me', authenticate, getMe);
router.delete('/me', authenticate, deleteAccount);
router.put('/profile', authenticate, updateProfileValidation, updateProfile);
router.post('/logout', authenticate, logout);
router.post('/change-password', authenticate, changePassword);
router.post('/apply-referral', authenticate, applyReferral);

export default router;
