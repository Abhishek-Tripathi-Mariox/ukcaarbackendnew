import { Response, NextFunction } from 'express';
import { User } from '../models';
import { AuthRequest } from './auth';

/**
 * Product rule: only an admin-approved driver may work — go online, be
 * dispatched, accept a ride, or start a trip.
 *
 * `driverProfile.registrationStep` is the source of truth: `/drivers/
 * registration/step` flips role → 'driver' during signup (so an account is a
 * "driver" long before it is vetted) and only adminDrivers.ts writes
 * 'approved' / 'rejected'. The driver app's own gating can be stale (a driver
 * rejected while the app is open) or bypassed entirely, so every server path
 * that hands out or starts work checks this — the app UI is a courtesy, this
 * is the enforcement.
 */

/** Minimal shape the checks need — accepts a full `IUser` or a lean projection. */
type DriverLike = {
  role?: string;
  driverProfile?: { registrationStep?: string } | null;
} | null;

/**
 * Mongo fragment for "a driver who is allowed to work". Drop into any query
 * that selects drivers to give work to (dispatch fan-out, admin assign,
 * scheduled-route vehicle lists) so the exclusion can't drift between them.
 */
export const APPROVED_DRIVER_QUERY = {
  role: 'driver',
  isActive: true,
  'driverProfile.registrationStep': 'approved',
} as const;

/**
 * Driver-facing explanation of why this account cannot work, or `null` when it
 * can. The states are genuinely different — rejected needs action from the
 * driver, pending needs patience — so the message says which one they are in
 * and what to do about it.
 */
export function driverWorkBlockReason(user: DriverLike | undefined): string | null {
  if (!user || user.role !== 'driver') {
    return 'Only drivers can do this.';
  }
  const step = user.driverProfile?.registrationStep;
  if (step === 'approved') return null;
  if (step === 'rejected') {
    return 'Your documents were rejected. Update them in Profile > Documents and resubmit for approval before you can go online.';
  }
  if (step === 'pending') {
    return 'Your documents are still under review. You can start driving as soon as an admin approves your account.';
  }
  return 'Finish your driver registration and submit your documents before you can start driving.';
}

/** True when this driver account is not cleared to work. */
export function isDriverBlockedFromWork(user: DriverLike | undefined): boolean {
  return driverWorkBlockReason(user) !== null;
}

/** Express gate for driver endpoints that hand out or begin work. */
export function requireApprovedDriver(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): void {
  const reason = driverWorkBlockReason(req.user as DriverLike);
  if (reason) {
    res.status(403).json({ success: false, message: reason });
    return;
  }
  next();
}

/**
 * Id-based variant for call sites that don't have `req.user` (payment paths,
 * admin assign where the target is someone else).
 */
export async function isUnapprovedDriver(userId: any): Promise<boolean> {
  const u: any = await User.findById(userId)
    .select('role driverProfile.registrationStep')
    .lean();
  return u?.role === 'driver' && u?.driverProfile?.registrationStep !== 'approved';
}
