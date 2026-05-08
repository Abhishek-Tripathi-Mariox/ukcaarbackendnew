/**
 * RBAC permissions for admin sub-roles.
 *
 * Backward compatibility: any User with role === 'admin' and no `adminRole` set
 * is treated as 'super_admin' (full access). Newly-invited admins MUST be given
 * an explicit adminRole.
 */

export const PERMISSIONS = {
  // Dashboard & analytics
  VIEW_DASHBOARD: 'view_dashboard',
  VIEW_ANALYTICS: 'view_analytics',
  EXPORT_REPORTS: 'export_reports',

  // Users
  VIEW_USERS: 'view_users',
  MANAGE_USERS: 'manage_users',          // edit / suspend / delete
  IMPERSONATE_USER: 'impersonate_user',

  // Drivers
  VIEW_DRIVERS: 'view_drivers',
  MANAGE_DRIVERS: 'manage_drivers',      // suspend / reactivate / commission
  APPROVE_DRIVERS: 'approve_drivers',    // application & document verification
  FORCE_OFFLINE: 'force_offline',

  // Rides
  VIEW_RIDES: 'view_rides',
  MANAGE_RIDES: 'manage_rides',          // cancel / reassign
  ADJUST_FARE: 'adjust_fare',
  RESOLVE_DISPUTE: 'resolve_dispute',

  // Payments
  VIEW_PAYMENTS: 'view_payments',
  REFUND_PAYMENTS: 'refund_payments',
  PROCESS_PAYOUTS: 'process_payouts',
  ADJUST_WALLET: 'adjust_wallet',
  VIEW_SETTLEMENTS: 'view_settlements',
  RECONCILE_SETTLEMENTS: 'reconcile_settlements',
  MANAGE_INVOICES: 'manage_invoices',

  // Promos
  VIEW_PROMOS: 'view_promos',
  MANAGE_PROMOS: 'manage_promos',

  // OnePass
  VIEW_ONEPASS: 'view_onepass',
  MANAGE_ONEPASS: 'manage_onepass',

  // Chat & support
  VIEW_CHATS: 'view_chats',
  VIEW_TICKETS: 'view_tickets',
  MANAGE_TICKETS: 'manage_tickets',
  ASSIGN_TICKETS: 'assign_tickets',

  // Notifications
  SEND_NOTIFICATIONS: 'send_notifications',
  VIEW_NOTIFICATION_TEMPLATES: 'view_notification_templates',
  MANAGE_NOTIFICATION_TEMPLATES: 'manage_notification_templates',

  // Driver incentives
  VIEW_INCENTIVES: 'view_incentives',
  MANAGE_INCENTIVES: 'manage_incentives',
  PAYOUT_INCENTIVES: 'payout_incentives',

  // Customer loyalty
  VIEW_LOYALTY: 'view_loyalty',
  MANAGE_LOYALTY: 'manage_loyalty',
  ADJUST_LOYALTY_POINTS: 'adjust_loyalty_points',

  // Zones / surge
  VIEW_ZONES: 'view_zones',
  MANAGE_ZONES: 'manage_zones',

  // Routes (private + scheduled / shuttle rides)
  VIEW_ROUTES: 'view_routes',
  MANAGE_ROUTES: 'manage_routes',

  // Settings
  VIEW_SETTINGS: 'view_settings',
  MANAGE_SETTINGS: 'manage_settings',

  // Admin governance
  MANAGE_ADMINS: 'manage_admins',        // invite / disable / role change
  VIEW_AUDIT_LOG: 'view_audit_log',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ADMIN_ROLES = ['super_admin', 'support', 'finance', 'ops_viewer'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

/** Default permission set per admin sub-role. */
export const ROLE_PERMISSIONS: Record<AdminRole, Permission[]> = {
  super_admin: ALL_PERMISSIONS,

  support: [
    PERMISSIONS.VIEW_DASHBOARD,
    PERMISSIONS.VIEW_USERS,
    PERMISSIONS.MANAGE_USERS,
    PERMISSIONS.VIEW_DRIVERS,
    PERMISSIONS.VIEW_RIDES,
    PERMISSIONS.MANAGE_RIDES,
    PERMISSIONS.RESOLVE_DISPUTE,
    PERMISSIONS.VIEW_CHATS,
    PERMISSIONS.VIEW_TICKETS,
    PERMISSIONS.MANAGE_TICKETS,
    PERMISSIONS.ASSIGN_TICKETS,
    PERMISSIONS.SEND_NOTIFICATIONS,
    PERMISSIONS.VIEW_PAYMENTS,
  ],

  finance: [
    PERMISSIONS.VIEW_DASHBOARD,
    PERMISSIONS.VIEW_ANALYTICS,
    PERMISSIONS.EXPORT_REPORTS,
    PERMISSIONS.VIEW_RIDES,
    PERMISSIONS.VIEW_PAYMENTS,
    PERMISSIONS.REFUND_PAYMENTS,
    PERMISSIONS.PROCESS_PAYOUTS,
    PERMISSIONS.ADJUST_WALLET,
    PERMISSIONS.VIEW_SETTLEMENTS,
    PERMISSIONS.RECONCILE_SETTLEMENTS,
    PERMISSIONS.MANAGE_INVOICES,
    PERMISSIONS.VIEW_DRIVERS,
    PERMISSIONS.VIEW_PROMOS,
    PERMISSIONS.VIEW_ONEPASS,
    PERMISSIONS.MANAGE_ONEPASS,
    PERMISSIONS.VIEW_INCENTIVES,
    PERMISSIONS.MANAGE_INCENTIVES,
    PERMISSIONS.PAYOUT_INCENTIVES,
    PERMISSIONS.VIEW_LOYALTY,
    PERMISSIONS.MANAGE_LOYALTY,
    PERMISSIONS.ADJUST_LOYALTY_POINTS,
  ],

  ops_viewer: [
    PERMISSIONS.VIEW_DASHBOARD,
    PERMISSIONS.VIEW_ANALYTICS,
    PERMISSIONS.VIEW_USERS,
    PERMISSIONS.VIEW_DRIVERS,
    PERMISSIONS.VIEW_RIDES,
    PERMISSIONS.VIEW_PAYMENTS,
    PERMISSIONS.VIEW_SETTLEMENTS,
    PERMISSIONS.VIEW_PROMOS,
    PERMISSIONS.VIEW_ONEPASS,
    PERMISSIONS.VIEW_CHATS,
    PERMISSIONS.VIEW_TICKETS,
    PERMISSIONS.VIEW_SETTINGS,
    PERMISSIONS.VIEW_INCENTIVES,
    PERMISSIONS.VIEW_LOYALTY,
    PERMISSIONS.VIEW_ZONES,
    PERMISSIONS.VIEW_ROUTES,
    PERMISSIONS.VIEW_NOTIFICATION_TEMPLATES,
  ],
};

/**
 * Resolve effective permissions for an admin user.
 * - Legacy admins (no adminRole) → super_admin
 * - Otherwise: role defaults plus any `adminPermissions` overrides.
 */
export function resolvePermissions(
  adminRole: AdminRole | undefined,
  overrides: Permission[] = []
): Set<Permission> {
  const role: AdminRole = adminRole ?? 'super_admin';
  const base = ROLE_PERMISSIONS[role] ?? [];
  return new Set<Permission>([...base, ...overrides]);
}

export function hasPermission(
  adminRole: AdminRole | undefined,
  overrides: Permission[] | undefined,
  required: Permission
): boolean {
  return resolvePermissions(adminRole, overrides ?? []).has(required);
}
