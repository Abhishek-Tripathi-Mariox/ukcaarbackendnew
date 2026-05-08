import { Router, Response } from 'express';
import crypto from 'crypto';
import { User, AuditLog } from '../models';
import { AuthRequest, requirePermission } from '../middleware/auth';
import { auditLog } from '../middleware/audit';
import {
  ADMIN_ROLES,
  AdminRole,
  PERMISSIONS,
  Permission,
  ROLE_PERMISSIONS,
  resolvePermissions,
} from '../config/permissions';

const router = Router();

// All routes here require an authenticated admin (mounted under /admin which
// is already gated by `authenticate`). Permission checks are added per route.

/** GET /admin/me/permissions — effective permissions for current admin. */
router.get('/me/permissions', (req: AuthRequest, res: Response) => {
  const u = req.user;
  if (!u || u.role !== 'admin') {
    res.status(403).json({ success: false, message: 'Admin access required' });
    return;
  }
  const adminRole: AdminRole = (u.adminRole as AdminRole | undefined) ?? 'super_admin';
  const permissions = Array.from(resolvePermissions(adminRole, u.adminPermissions));
  res.json({
    success: true,
    data: {
      adminRole,
      permissions,
      overrides: u.adminPermissions ?? [],
      catalog: {
        roles: ADMIN_ROLES,
        permissions: Object.values(PERMISSIONS),
        rolePermissions: ROLE_PERMISSIONS,
      },
    },
  });
});

// ════════════════════════════════════════════════════════════════════
// ADMIN USER MANAGEMENT
// ════════════════════════════════════════════════════════════════════

/** GET /admin/admins — list admin users. */
router.get(
  '/admins',
  requirePermission(PERMISSIONS.MANAGE_ADMINS),
  async (req: AuthRequest, res: Response) => {
    try {
      const page = Math.max(1, parseInt((req.query.page as string) || '1', 10));
      const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) || '20', 10)));
      const search = (req.query.search as string) || '';
      const role = req.query.adminRole as string | undefined;

      const filter: Record<string, unknown> = { role: 'admin' };
      if (role && (ADMIN_ROLES as readonly string[]).includes(role)) {
        filter.adminRole = role;
      }
      if (search) {
        filter.$or = [
          { email: new RegExp(search, 'i') },
          { firstName: new RegExp(search, 'i') },
          { lastName: new RegExp(search, 'i') },
        ];
      }

      const [items, total] = await Promise.all([
        User.find(filter)
          .select(
            'firstName lastName email adminRole adminPermissions isActive lastLoginAt lastLoginIp invitedBy invitedAt disabledAt disabledReason createdAt'
          )
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit),
        User.countDocuments(filter),
      ]);

      res.json({
        success: true,
        data: { items, total, page, limit, pages: Math.ceil(total / limit) },
      });
    } catch (err) {
      console.error('list admins error:', err);
      res.status(500).json({ success: false, message: 'Failed to list admins' });
    }
  }
);

function isValidRole(role: unknown): role is AdminRole {
  return typeof role === 'string' && (ADMIN_ROLES as readonly string[]).includes(role);
}

function sanitizePermissions(perms: unknown): Permission[] | undefined {
  if (!Array.isArray(perms)) return undefined;
  const valid = new Set(Object.values(PERMISSIONS) as string[]);
  const filtered = perms.filter((p): p is Permission => typeof p === 'string' && valid.has(p));
  return Array.from(new Set(filtered));
}

/** POST /admin/admins/invite — create a new admin user. */
router.post(
  '/admins/invite',
  requirePermission(PERMISSIONS.MANAGE_ADMINS),
  auditLog({
    action: 'admin.invite',
    resourceType: 'User',
    metadata: (req) => ({ email: req.body?.email, adminRole: req.body?.adminRole }),
  }),
  async (req: AuthRequest, res: Response) => {
    try {
      const { email, firstName, lastName, phone, adminRole, permissions } = req.body ?? {};
      if (!email || !firstName) {
        res.status(400).json({ success: false, message: 'email and firstName are required' });
        return;
      }
      if (!isValidRole(adminRole)) {
        res.status(400).json({ success: false, message: 'Invalid adminRole' });
        return;
      }

      const normalizedEmail = String(email).toLowerCase().trim();
      const existing = await User.findOne({ email: normalizedEmail });
      if (existing) {
        res.status(409).json({ success: false, message: 'Email already in use' });
        return;
      }

      // Generate a strong temporary password the inviter must share out-of-band.
      const tempPassword = crypto.randomBytes(12).toString('base64url');

      const created = await User.create({
        email: normalizedEmail,
        firstName,
        lastName: lastName ?? '',
        phone: phone || `invite-${Date.now()}`,
        password: tempPassword,
        role: 'admin',
        adminRole,
        adminPermissions: sanitizePermissions(permissions),
        isVerified: true,
        isActive: true,
        invitedBy: req.user?._id,
        invitedAt: new Date(),
      });

      res.status(201).json({
        success: true,
        data: {
          admin: {
            _id: created._id,
            email: created.email,
            firstName: created.firstName,
            lastName: created.lastName,
            adminRole: created.adminRole,
          },
          // Returned ONCE so the inviter can share it. Not stored anywhere else.
          temporaryPassword: tempPassword,
        },
      });
    } catch (err) {
      console.error('invite admin error:', err);
      res.status(500).json({ success: false, message: 'Failed to invite admin' });
    }
  }
);

/** PATCH /admin/admins/:id — update role / permission overrides / active. */
router.patch(
  '/admins/:id',
  requirePermission(PERMISSIONS.MANAGE_ADMINS),
  auditLog({ action: 'admin.update', resourceType: 'User' }),
  async (req: AuthRequest, res: Response) => {
    try {
      const target = await User.findOne({ _id: req.params.id, role: 'admin' });
      if (!target) {
        res.status(404).json({ success: false, message: 'Admin not found' });
        return;
      }

      // Prevent self-lockout
      if (target._id.toString() === req.user?._id.toString()) {
        if (req.body.isActive === false || req.body.adminRole !== undefined) {
          res
            .status(400)
            .json({ success: false, message: 'You cannot change your own role or status' });
          return;
        }
      }

      if (req.body.adminRole !== undefined) {
        if (!isValidRole(req.body.adminRole)) {
          res.status(400).json({ success: false, message: 'Invalid adminRole' });
          return;
        }
        target.adminRole = req.body.adminRole;
      }
      if (req.body.permissions !== undefined) {
        target.adminPermissions = sanitizePermissions(req.body.permissions);
      }
      if (req.body.firstName !== undefined) target.firstName = req.body.firstName;
      if (req.body.lastName !== undefined) target.lastName = req.body.lastName;

      if (req.body.isActive !== undefined) {
        target.isActive = !!req.body.isActive;
        if (!target.isActive) {
          target.disabledAt = new Date();
          target.disabledReason = req.body.reason || 'Disabled by admin';
        } else {
          target.disabledAt = undefined;
          target.disabledReason = undefined;
        }
      }

      await target.save();
      res.json({ success: true, data: { admin: target } });
    } catch (err) {
      console.error('update admin error:', err);
      res.status(500).json({ success: false, message: 'Failed to update admin' });
    }
  }
);

/** POST /admin/admins/:id/reset-password — generate new temp password. */
router.post(
  '/admins/:id/reset-password',
  requirePermission(PERMISSIONS.MANAGE_ADMINS),
  auditLog({ action: 'admin.reset_password', resourceType: 'User' }),
  async (req: AuthRequest, res: Response) => {
    try {
      const target = await User.findOne({ _id: req.params.id, role: 'admin' });
      if (!target) {
        res.status(404).json({ success: false, message: 'Admin not found' });
        return;
      }
      const tempPassword = crypto.randomBytes(12).toString('base64url');
      target.password = tempPassword;
      target.refreshToken = undefined;
      await target.save();
      res.json({ success: true, data: { temporaryPassword: tempPassword } });
    } catch (err) {
      console.error('reset password error:', err);
      res.status(500).json({ success: false, message: 'Failed to reset password' });
    }
  }
);

// ════════════════════════════════════════════════════════════════════
// AUDIT LOG
// ════════════════════════════════════════════════════════════════════

/** GET /admin/audit-logs — query audit log with filters & pagination. */
router.get(
  '/audit-logs',
  requirePermission(PERMISSIONS.VIEW_AUDIT_LOG),
  async (req: AuthRequest, res: Response) => {
    try {
      const page = Math.max(1, parseInt((req.query.page as string) || '1', 10));
      const limit = Math.min(200, Math.max(1, parseInt((req.query.limit as string) || '50', 10)));

      const filter: Record<string, unknown> = {};
      if (req.query.actorId) filter.actorId = req.query.actorId;
      if (req.query.action) filter.action = req.query.action;
      if (req.query.resourceType) filter.resourceType = req.query.resourceType;
      if (req.query.resourceId) filter.resourceId = req.query.resourceId;
      if (req.query.outcome) filter.outcome = req.query.outcome;

      if (req.query.startDate || req.query.endDate) {
        const range: Record<string, Date> = {};
        if (req.query.startDate) range.$gte = new Date(req.query.startDate as string);
        if (req.query.endDate) range.$lte = new Date(req.query.endDate as string);
        filter.createdAt = range;
      }

      const [items, total, actions] = await Promise.all([
        AuditLog.find(filter)
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        AuditLog.countDocuments(filter),
        AuditLog.distinct('action'),
      ]);

      res.json({
        success: true,
        data: {
          items,
          total,
          page,
          limit,
          pages: Math.ceil(total / limit),
          facets: { actions },
        },
      });
    } catch (err) {
      console.error('audit list error:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch audit logs' });
    }
  }
);

/** GET /admin/audit-logs/:id — single entry detail. */
router.get(
  '/audit-logs/:id',
  requirePermission(PERMISSIONS.VIEW_AUDIT_LOG),
  async (req: AuthRequest, res: Response) => {
    try {
      const entry = await AuditLog.findById(req.params.id).lean();
      if (!entry) {
        res.status(404).json({ success: false, message: 'Audit entry not found' });
        return;
      }
      res.json({ success: true, data: entry });
    } catch (err) {
      console.error('audit detail error:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch audit entry' });
    }
  }
);

export default router;
