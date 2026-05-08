import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { validationResult } from 'express-validator';
import { User, Wallet, AuditLog } from '../models';
import { config } from '../config';
import { AuthRequest } from '../middleware/auth';
import { resolvePermissions } from '../config/permissions';

// ── Generate tokens ──
const generateTokens = (userId: string, role: string) => {
  const accessToken = jwt.sign(
    { userId, role },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn } as jwt.SignOptions
  );
  const refreshToken = jwt.sign(
    { userId, role },
    config.jwt.refreshSecret,
    { expiresIn: config.jwt.refreshExpiresIn } as jwt.SignOptions
  );
  return { accessToken, refreshToken };
};

// ── Generate 6-digit OTP ──
const generateOTP = (): string => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

/**
 * POST /api/v1/auth/send-otp
 * Send OTP to phone number
 */
export const sendOtp = async (req: Request, res: Response): Promise<void> => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, errors: errors.array() });
      return;
    }

    const { phone, countryCode = '+44' } = req.body;
    const fullPhone = `${countryCode}${phone.replace(/\s/g, '')}`;

    // Generate OTP
    const otp = generateOTP();
    const otpExpiry = new Date(Date.now() + 5 * 60 * 1000); // 5 min

    // Find or create user
    let user = await User.findOne({ phone: fullPhone });
    if (!user) {
      user = new User({
        phone: fullPhone,
        countryCode,
        isProfileSetup: false,
      });
    }

    user.otp = otp;
    user.otpExpiry = otpExpiry;
    await user.save();

    // In production, send via Twilio/SMS provider
    // await twilioClient.messages.create({ to: fullPhone, body: `Your UKCAAR code is: ${otp}` });

    const isTestMode = config.env === 'development' || process.env.TEST_MODE === 'true';
    console.log(`📱 OTP for ${fullPhone}: ${otp}`);

    res.status(200).json({
      success: true,
      message: 'OTP sent successfully',
      // Return OTP in dev/test mode for testing
      ...(isTestMode && { otp }),
    });
  } catch (error) {
    console.error('sendOtp error:', error);
    res.status(500).json({ success: false, message: 'Failed to send OTP' });
  }
};

/**
 * POST /api/v1/auth/verify-otp
 * Verify OTP and return tokens
 */
export const verifyOtp = async (req: Request, res: Response): Promise<void> => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, errors: errors.array() });
      return;
    }

    const { phone, otp, countryCode = '+44' } = req.body;
    const fullPhone = `${countryCode}${phone.replace(/\s/g, '')}`;

    const user = await User.findOne({ phone: fullPhone }).select('+otp +otpExpiry');
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    // Dev/Test bypass: accept "115566" in development or when TEST_MODE is enabled
    const isTestMode = config.env === 'development' || process.env.TEST_MODE === 'true';
    const isValidOtp =
      (isTestMode && otp === '115566') ||
      (user.otp === otp && user.otpExpiry && user.otpExpiry > new Date());

    if (!isValidOtp) {
      res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
      return;
    }

    // Mark verified, clear OTP
    user.isVerified = true;
    user.otp = undefined;
    user.otpExpiry = undefined;

    const tokens = generateTokens(user._id.toString(), user.role);
    user.refreshToken = tokens.refreshToken;
    await user.save();

    // Ensure wallet exists
    await Wallet.findOneAndUpdate(
      { user: user._id },
      { $setOnInsert: { user: user._id, balance: 0, currency: 'INR' } },
      { upsert: true, new: true }
    );

    res.status(200).json({
      success: true,
      message: 'OTP verified successfully',
      data: {
        user: {
          id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          phone: user.phone,
          email: user.email,
          role: user.role,
          isVerified: user.isVerified,
          avatar: user.avatar,
          isProfileSetup: !!(user as any).isProfileSetup,
          // For the driver app's resume-registration flow: where in the
          // signup funnel they left off (or 'approved' once admin signs off).
          registrationStep: user.driverProfile?.registrationStep ?? null,
        },
        tokens,
      },
    });
  } catch (error) {
    console.error('verifyOtp error:', error);
    res.status(500).json({ success: false, message: 'Verification failed' });
  }
};

/**
 * POST /api/v1/auth/refresh-token
 */
export const refreshToken = async (req: Request, res: Response): Promise<void> => {
  try {
    const { refreshToken: token } = req.body;
    if (!token) {
      res.status(400).json({ success: false, message: 'Refresh token is required' });
      return;
    }

    const decoded = jwt.verify(token, config.jwt.refreshSecret) as {
      userId: string;
      role: string;
    };

    const user = await User.findById(decoded.userId).select('+refreshToken');
    if (!user || user.refreshToken !== token) {
      res.status(401).json({ success: false, message: 'Invalid refresh token' });
      return;
    }

    const tokens = generateTokens(user._id.toString(), user.role);
    user.refreshToken = tokens.refreshToken;
    await user.save();

    res.status(200).json({ success: true, data: { tokens } });
  } catch (error) {
    res.status(401).json({ success: false, message: 'Token refresh failed' });
  }
};

/**
 * POST /api/v1/auth/logout
 */
export const logout = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (req.user) {
      await User.findByIdAndUpdate(req.user._id, { refreshToken: null });
    }
    res.status(200).json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Logout failed' });
  }
};

/**
 * GET /api/v1/auth/me
 */
export const getMe = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await User.findById(req.user?._id);
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    const wallet = await Wallet.findOne({ user: user._id });

    res.status(200).json({
      success: true,
      data: {
        user,
        wallet: wallet ? { balance: wallet.balance, currency: wallet.currency } : null,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch profile' });
  }
};

/**
 * PUT /api/v1/auth/profile
 */
export const updateProfile = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, errors: errors.array() });
      return;
    }

    const allowedFields = ['firstName', 'lastName', 'email', 'avatar', 'language'];
    const updateData: Record<string, any> = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    }
    // Mark profile as setup once user provides their name
    if (updateData.firstName) {
      updateData.isProfileSetup = true;
    }

    const user = await User.findByIdAndUpdate(req.user?._id, updateData, {
      new: true,
      runValidators: true,
    });

    res.status(200).json({ success: true, data: { user } });
  } catch (error: any) {
    console.error('updateProfile error:', error?.message, error?.code, error?.keyPattern);
    res.status(500).json({ success: false, message: error?.message || 'Profile update failed' });
  }
};

/**
 * POST /api/v1/auth/driver-signup
 */
export const driverSignup = async (req: Request, res: Response): Promise<void> => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, errors: errors.array() });
      return;
    }

    const {
      firstName, lastName, email, phone, countryCode = '+44',
      licenceNumber, vehicleMake, vehicleModel, vehicleYear,
      vehicleColor, plateNumber, insuranceNumber,
    } = req.body;

    const fullPhone = `${countryCode}${phone.replace(/\s/g, '')}`;

    // Check if driver already exists
    let user = await User.findOne({ phone: fullPhone });
    if (user && user.role === 'driver') {
      res.status(400).json({ success: false, message: 'Driver account already exists' });
      return;
    }

    if (!user) {
      user = new User({
        firstName,
        lastName,
        email,
        phone: fullPhone,
        countryCode,
        role: 'driver',
        driverProfile: {
          licenceNumber,
          vehicleMake,
          vehicleModel,
          vehicleYear,
          vehicleColor,
          plateNumber,
          insuranceNumber: insuranceNumber || '',
        },
      });
    } else {
      user.role = 'driver';
      user.firstName = firstName;
      user.lastName = lastName;
      user.email = email;
      user.driverProfile = {
        licenceNumber,
        vehicleMake,
        vehicleModel,
        vehicleYear,
        vehicleColor,
        plateNumber,
        insuranceNumber: insuranceNumber || '',
        isOnline: false,
        rating: 5.0,
        totalTrips: 0,
        totalEarnings: 0,
        isOnePass: false,
        documents: [],
      };
    }

    await user.save();

    // Send OTP for verification
    const otp = generateOTP();
    user.otp = otp;
    user.otpExpiry = new Date(Date.now() + 5 * 60 * 1000);
    await user.save();

    console.log(`📱 Driver OTP for ${fullPhone}: ${otp}`);

    res.status(201).json({
      success: true,
      message: 'Driver registration submitted. OTP sent for verification.',
      ...(config.env === 'development' && { otp }),
    });
  } catch (error) {
    console.error('driverSignup error:', error);
    res.status(500).json({ success: false, message: 'Registration failed' });
  }
};

/**
 * POST /api/v1/auth/login
 * Email + password login (used by the admin dashboard).
 *
 * Records lastLoginAt/IP and writes an audit log entry. Rejects accounts
 * that have been disabled.
 */
export const adminLogin = async (req: Request, res: Response): Promise<void> => {
  const ip = req.ip;
  const userAgent = req.headers['user-agent'];
  let actorId: string | undefined;
  let actorEmail: string | undefined = (req.body?.email ?? '').toString().toLowerCase();

  try {
    const { email, password } = req.body ?? {};
    if (!email || !password) {
      res.status(400).json({ success: false, message: 'Email and password are required' });
      return;
    }

    const user = await User.findOne({ email: actorEmail }).select('+password');
    if (!user || !user.password) {
      res.status(401).json({ success: false, message: 'Invalid credentials' });
      return;
    }
    if (user.role !== 'admin') {
      res.status(403).json({ success: false, message: 'Admin access required' });
      return;
    }
    if (!user.isActive) {
      res.status(403).json({ success: false, message: 'Account disabled' });
      return;
    }

    const ok = await user.comparePassword(password);
    if (!ok) {
      res.status(401).json({ success: false, message: 'Invalid credentials' });
      return;
    }

    actorId = user._id.toString();

    const tokens = generateTokens(user._id.toString(), user.role);
    user.refreshToken = tokens.refreshToken;
    user.lastLoginAt = new Date();
    user.lastLoginIp = ip;
    await user.save();

    const permissions = Array.from(
      resolvePermissions(user.adminRole, user.adminPermissions)
    );

    AuditLog.create({
      actorId: user._id,
      actorEmail: user.email,
      actorRole: user.role,
      actorAdminRole: user.adminRole,
      action: 'admin.login',
      method: 'POST',
      path: req.originalUrl ?? req.url,
      statusCode: 200,
      outcome: 'success',
      ip,
      userAgent,
    }).catch((err) => console.error('[audit] login log failed:', err?.message ?? err));

    res.status(200).json({
      success: true,
      data: {
        user: {
          _id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          role: user.role,
          adminRole: user.adminRole ?? 'super_admin',
          permissions,
          avatar: user.avatar,
          lastLoginAt: user.lastLoginAt,
        },
        token: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      },
    });
  } catch (error) {
    console.error('adminLogin error:', error);
    AuditLog.create({
      actorId: actorId ?? undefined,
      actorEmail,
      action: 'admin.login',
      method: 'POST',
      path: req.originalUrl ?? req.url,
      statusCode: 500,
      outcome: 'failure',
      ip,
      userAgent,
      errorMessage: (error as Error)?.message,
    }).catch(() => undefined);
    res.status(500).json({ success: false, message: 'Login failed' });
  }
};

/**
 * POST /api/v1/auth/forgot-password
 * Request a password reset OTP for an admin email.
 * Always returns success (does not reveal whether the email exists).
 */
export const forgotPassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const email = (req.body?.email ?? '').toString().toLowerCase().trim();
    if (!email) {
      res.status(400).json({ success: false, message: 'Email is required' });
      return;
    }

    const user = await User.findOne({ email });
    const isTestMode = config.env === 'development' || process.env.TEST_MODE === 'true';

    if (user && user.role === 'admin' && user.isActive) {
      const otp = generateOTP();
      user.otp = otp;
      user.otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 min
      await user.save();

      // In production, dispatch via email/SMS provider here.
      console.log(`📧 Password reset OTP for ${email}: ${otp}`);
    }

    res.status(200).json({
      success: true,
      message: 'If an account exists for that email, a reset code has been sent.',
      // Dev convenience: surface the universal test OTP so the panel can pre-fill / show it.
      ...(isTestMode && { devOtp: '115566' }),
    });
  } catch (error) {
    console.error('forgotPassword error:', error);
    res.status(500).json({ success: false, message: 'Failed to process request' });
  }
};

/**
 * POST /api/v1/auth/reset-password
 * Verify OTP and set a new password.
 * Accepts the universal dev OTP "115566" in development / TEST_MODE.
 */
export const resetPassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const email = (req.body?.email ?? '').toString().toLowerCase().trim();
    const { otp, newPassword } = req.body ?? {};

    if (!email || !otp || !newPassword) {
      res.status(400).json({ success: false, message: 'Email, OTP, and new password are required' });
      return;
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
      return;
    }

    const user = await User.findOne({ email }).select('+otp +otpExpiry +password');
    if (!user || user.role !== 'admin' || !user.isActive) {
      res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
      return;
    }

    const isTestMode = config.env === 'development' || process.env.TEST_MODE === 'true';
    const otpMatches =
      (isTestMode && otp === '115566') ||
      (user.otp === otp && user.otpExpiry && user.otpExpiry > new Date());

    if (!otpMatches) {
      res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
      return;
    }

    user.password = newPassword; // hashed by pre('save')
    user.otp = undefined;
    user.otpExpiry = undefined;
    user.refreshToken = undefined; // force re-login on other sessions
    await user.save();

    AuditLog.create({
      actorId: user._id,
      actorEmail: user.email,
      actorRole: user.role,
      actorAdminRole: user.adminRole,
      action: 'admin.reset_password',
      method: 'POST',
      path: req.originalUrl ?? req.url,
      statusCode: 200,
      outcome: 'success',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    }).catch(() => undefined);

    res.status(200).json({ success: true, message: 'Password reset successful' });
  } catch (error) {
    console.error('resetPassword error:', error);
    res.status(500).json({ success: false, message: 'Failed to reset password' });
  }
};

/**
 * POST /api/v1/auth/change-password
 * Authenticated admin changes their own password by supplying current + new.
 */
export const changePassword = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { currentPassword, newPassword } = req.body ?? {};
    if (!currentPassword || !newPassword) {
      res.status(400).json({ success: false, message: 'Current and new password are required' });
      return;
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      res.status(400).json({ success: false, message: 'New password must be at least 8 characters' });
      return;
    }
    if (currentPassword === newPassword) {
      res.status(400).json({ success: false, message: 'New password must be different' });
      return;
    }

    const user = await User.findById(req.user?._id).select('+password');
    if (!user || !user.password) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    const ok = await user.comparePassword(currentPassword);
    if (!ok) {
      res.status(401).json({ success: false, message: 'Current password is incorrect' });
      return;
    }

    user.password = newPassword;
    user.refreshToken = undefined;
    await user.save();

    AuditLog.create({
      actorId: user._id,
      actorEmail: user.email,
      actorRole: user.role,
      actorAdminRole: user.adminRole,
      action: 'admin.change_password',
      method: 'POST',
      path: req.originalUrl ?? req.url,
      statusCode: 200,
      outcome: 'success',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    }).catch(() => undefined);

    res.status(200).json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    console.error('changePassword error:', error);
    res.status(500).json({ success: false, message: 'Failed to change password' });
  }
};
