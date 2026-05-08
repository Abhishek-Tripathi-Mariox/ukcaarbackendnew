import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { User, IUser } from '../models';
import { hasPermission, Permission } from '../config/permissions';

export interface AuthRequest extends Request {
  user?: IUser;
}

export const authenticate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ success: false, message: 'No token provided' });
      return;
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, config.jwt.secret) as { userId: string; role: string };

    const user = await User.findById(decoded.userId);
    if (!user || !user.isActive) {
      res.status(401).json({ success: false, message: 'Invalid or expired token' });
      return;
    }

    req.user = user;
    next();
  } catch (error) {
    console.log(error)
    res.status(401).json({ success: false, message: 'Authentication failed' });
  }
};

export const authorize = (...roles: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ success: false, message: 'Insufficient permissions' });
      return;
    }
    next();
  };
};

/**
 * Permission-based gate for admin routes. Requires `authenticate` first.
 * Pass one or more required permissions; the request is allowed if the
 * admin's effective permission set contains ANY of them.
 *
 * Legacy admins (role='admin', no adminRole) are treated as super_admin.
 */
export const requirePermission = (...required: Permission[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    const user = req.user;
    if (!user || user.role !== 'admin') {
      res.status(403).json({ success: false, message: 'Admin access required' });
      return;
    }
    const allowed = required.some((perm) =>
      hasPermission(user.adminRole, user.adminPermissions, perm)
    );
    if (!allowed) {
      res.status(403).json({
        success: false,
        message: 'Insufficient permissions',
        requiredPermissions: required,
      });
      return;
    }
    next();
  };
};
