import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { validationResult } from 'express-validator';
import { User, Wallet, Payment, AuditLog } from '../models';
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

    const { phone, countryCode = '+44', appType } = req.body;
    const fullPhone = `${countryCode}${phone.replace(/\s/g, '')}`;

    // Generate OTP
    const otp = generateOTP();
    const otpExpiry = new Date(Date.now() + 5 * 60 * 1000); // 5 min

    // Find or create user
    let user = await User.findOne({ phone: fullPhone });

    // App-scoped role guard. The customer and driver apps share this OTP
    // endpoint, so a driver/admin account must not be able to sign into the
    // customer app. The customer app sends appType:'customer'; the driver app
    // omits it (its new signups default to role:'customer' until registration
    // sets role:'driver', so we deliberately do NOT enforce the driver side
    // here). Fail fast before an OTP is ever issued.
    if (user && appType === 'customer' && user.role !== 'customer') {
      res.status(403).json({
        success: false,
        message: 'This number is registered as a driver. Please use the UKCAAR Driver app to sign in.',
      });
      return;
    }

    // Suspended accounts must not receive an OTP at all. The authenticate
    // middleware already rejects isActive=false on API calls, but without
    // this check the OTP LOGIN itself succeeded and the app landed a
    // suspended user on Home with a dead token.
    if (user && !user.isActive) {
      res.status(403).json({
        success: false,
        message: 'Your account has been suspended. Please contact support.',
      });
      return;
    }

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

    // No SMS provider yet (client-testing phase). The universal test OTP
    // (config.auth.testOtp, e.g. "115566") is what testers actually use to log
    // in; we also surface the generated per-user OTP in the response while the
    // test flag is on, for convenience.
    console.log(`📱 OTP for ${fullPhone}: ${otp}`);

    res.status(200).json({
      success: true,
      message: 'OTP sent successfully',
      ...(config.auth.allowTestOtp && { otp }),
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

    const { phone, otp, countryCode = '+44', appType } = req.body;
    const fullPhone = `${countryCode}${phone.replace(/\s/g, '')}`;

    const user = await User.findOne({ phone: fullPhone }).select('+otp +otpExpiry');
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    // App-scoped role guard (see sendOtp): keep drivers/admins out of the
    // customer app even if they somehow reach verify-otp directly.
    if (appType === 'customer' && user.role !== 'customer') {
      res.status(403).json({
        success: false,
        message: 'This number is registered as a driver. Please use the UKCAAR Driver app to sign in.',
      });
      return;
    }

    // Suspended accounts: refuse token issuance (see sendOtp). Checked here
    // too because verify-otp is public and an OTP may pre-date the suspension.
    if (!user.isActive) {
      res.status(403).json({
        success: false,
        message: 'Your account has been suspended. Please contact support.',
      });
      return;
    }

    // Universal test OTP (client-testing phase — no SMS provider). Accepts
    // config.auth.testOtp for any user while config.auth.allowTestOtp is on.
    // See config/index.ts for the security warning.
    const isValidOtp =
      (config.auth.allowTestOtp && otp === config.auth.testOtp) ||
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
    // !isActive: a suspended user's live session must not keep minting fresh
    // access tokens — suspension takes effect at the next refresh at latest.
    if (!user || user.refreshToken !== token || !user.isActive) {
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

    const [wallet, referralCount] = await Promise.all([
      Wallet.findOne({ user: user._id }),
      User.countDocuments({ referredBy: user._id }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        user,
        wallet: wallet ? { balance: wallet.balance, currency: wallet.currency } : null,
        referrals: { count: referralCount },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch profile' });
  }
};

/**
 * POST /api/v1/auth/apply-referral
 * Apply someone else's referral code to the signed-in account. This sets
 * `referredBy` (the linkage that drives the referrer's referral count) and
 * optionally credits a one-time wallet bonus (config.referral.bonus).
 * Guards: code must exist, can't be your own, and can only be applied once.
 */
export const applyReferral = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const code = String(req.body?.code ?? '').trim().toUpperCase();
    if (!code) {
      res.status(400).json({ success: false, message: 'Referral code is required' });
      return;
    }

    const me = await User.findById(req.user!._id);
    if (!me) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }
    if (me.referredBy) {
      res.status(400).json({ success: false, message: 'A referral code has already been applied to your account' });
      return;
    }

    const referrer = await User.findOne({ referralCode: code });
    if (!referrer) {
      res.status(404).json({ success: false, message: 'Invalid referral code' });
      return;
    }
    if (String(referrer._id) === String(me._id)) {
      res.status(400).json({ success: false, message: "You can't use your own referral code" });
      return;
    }

    // Atomic claim on referredBy. The old read-check-save let N parallel
    // requests all pass the `me.referredBy` check above and each credit the
    // joiner bonus — N × referralBonus minted from one code. Only the request
    // that flips the field from unset wins; everyone else 400s below.
    const linked = await User.findOneAndUpdate(
      {
        _id: me._id,
        $or: [{ referredBy: null }, { referredBy: { $exists: false } }],
      },
      { $set: { referredBy: referrer._id } },
      { new: true },
    );
    if (!linked) {
      res.status(400).json({
        success: false,
        message: 'A referral code has already been applied to your account',
      });
      return;
    }

    // One-time joiner bonus. Admin-configured value (Settings.referralBonus)
    // takes precedence over the env default. Guarded by referredBy being
    // previously unset, so it can never be claimed twice.
    const settings = await (await import('../models')).Settings.findOne({ key: 'platform' })
      .select('referralBonus')
      .lean();
    const bonus = settings?.referralBonus ?? config.referral.bonus;
    if (bonus > 0) {
      await Wallet.findOneAndUpdate(
        { user: me._id },
        { $inc: { balance: bonus } },
        { upsert: true }
      );
      await Payment.create({
        user: me._id,
        type: 'bonus',
        amount: bonus,
        method: 'wallet',
        status: 'completed',
        description: `Referral bonus (code ${referrer.referralCode})`,
      });
    }

    res.json({
      success: true,
      data: {
        applied: true,
        bonusCredited: bonus,
        referrerName: [referrer.firstName, referrer.lastName].filter(Boolean).join(' '),
      },
    });
  } catch (error) {
    console.error('applyReferral error:', error);
    res.status(500).json({ success: false, message: 'Failed to apply referral code' });
  }
};

/**
 * DELETE /api/v1/auth/me
 * Self-service account deletion. Deactivates the account (isActive=false) —
 * which the auth middleware and OTP login both already reject — so the user
 * is immediately and permanently locked out. Data is retained for legal /
 * settlement records and can be hard-purged by a back-office job.
 */
export const deleteAccount = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    // Deactivate AND release the identifiers. Just flipping isActive meant:
    //  (a) the phone number was locked forever — the user could never sign up
    //      again, and
    //  (b) a re-login attempt showed "Your account has been suspended",
    //      which read as "my account never actually got deleted".
    // Mangling the phone/email frees them for a fresh signup while keeping
    // the row (rides, payments, ledger history) intact for audit.
    const me = await User.findById(req.user!._id).select('phone email');
    if (!me) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }
    const stamp = Date.now();
    await User.findByIdAndUpdate(req.user!._id, {
      $set: {
        isActive: false,
        deletedAt: new Date(),
        phone: `deleted_${stamp}_${me.phone ?? ''}`,
        ...(me.email ? { email: `deleted_${stamp}_${me.email}` } : {}),
      },
    });
    res.json({ success: true, message: 'Your account has been deleted.' });
  } catch (error) {
    console.error('deleteAccount error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete account' });
  }
};

/**
 * PUT /api/v1/auth/profile
 */
export const updateProfile = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // Include a human-readable message — the apps surface `message` only,
      // so a bare errors[] rendered as the useless generic "Profile update
      // failed" with no hint of what was wrong.
      const first = errors.array()[0] as any;
      res.status(400).json({
        success: false,
        message: first?.msg ? `${first.path ?? 'Field'}: ${first.msg}` : 'Invalid profile data',
        errors: errors.array(),
      });
      return;
    }

    const allowedFields = ['firstName', 'lastName', 'email', 'avatar', 'language'];
    const updateData: Record<string, any> = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    }
    // Blank email means "remove my email", and must be $unset rather than
    // written as ''. The email unique index is sparse, which skips ABSENT
    // fields but not empty strings — so persisting '' for two users throws
    // E11000 and every later profile save 500s (same bug previously fixed at
    // signup by removing `default: ''` on the schema).
    const unsetData: Record<string, 1> = {};
    if (updateData.email !== undefined && String(updateData.email).trim() === '') {
      delete updateData.email;
      unsetData.email = 1;
    }
    // Mark profile as setup once user provides their name
    if (updateData.firstName) {
      updateData.isProfileSetup = true;
    }

    const user = await User.findByIdAndUpdate(
      req.user?._id,
      Object.keys(unsetData).length ? { $set: updateData, $unset: unsetData } : updateData,
      {
        new: true,
        runValidators: true,
      },
    );

    res.status(200).json({ success: true, data: { user } });
  } catch (error: any) {
    console.error('updateProfile error:', error?.message, error?.code, error?.keyPattern);
    // Duplicate-key (E11000) on the unique email index — tell the user what
    // actually happened instead of a raw Mongo error string via a 500.
    if (error?.code === 11000 && error?.keyPattern?.email) {
      res.status(409).json({
        success: false,
        message: 'This email is already in use by another account.',
      });
      return;
    }
    res.status(500).json({ success: false, message: 'Profile update failed' });
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
        // A brand-new driver has no ratings yet — true value is 0 (the apps
        // display a neutral 5.0 until the first real rating). Was 5.0.
        rating: 0,
        ratingCount: 0,
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
      // Surface the universal test OTP so the panel can pre-fill / show it.
      ...(config.auth.allowTestOtp && { devOtp: config.auth.testOtp }),
    });
  } catch (error) {
    console.error('forgotPassword error:', error);
    res.status(500).json({ success: false, message: 'Failed to process request' });
  }
};

/**
 * POST /api/v1/auth/reset-password
 * Verify OTP and set a new password.
 * Accepts the universal test OTP (config.auth.testOtp) while config.auth.allowTestOtp is on.
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

    const otpMatches =
      (config.auth.allowTestOtp && otp === config.auth.testOtp) ||
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
