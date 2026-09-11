/**
 * التحكم بالوصول المبني على الأدوار (RBAC).
 * مصفوفة صلاحيات صريحة — الأقل امتيازًا افتراضيًا (default deny).
 */
import type { Role } from '../db/types.js';

export const ROLES: Role[] = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF'];

export type Permission =
  | 'services.read'
  | 'services.write'
  | 'bookings.read'
  | 'bookings.write'        // تأكيد/إكمال/تعديل أي حجز
  | 'bookings.cancel'
  | 'orders.read'
  | 'orders.write'
  | 'tickets.read'
  | 'tickets.write'
  | 'customers.read'
  | 'conversations.takeover'
  | 'staff.read'
  | 'staff.write'
  | 'audit.read'
  | 'metrics.read';

const MATRIX: Record<Role, Permission[]> = {
  STAFF: [
    'services.read',
    'bookings.read',
    'orders.read',
    'tickets.read',
    'tickets.write',
    'customers.read',
    'conversations.takeover',
    'metrics.read',
  ],
  MANAGER: [
    'services.read',
    'bookings.read', 'bookings.write', 'bookings.cancel',
    'orders.read', 'orders.write',
    'tickets.read', 'tickets.write',
    'customers.read',
    'conversations.takeover',
    'metrics.read',
  ],
  ADMIN: [
    'services.read', 'services.write',
    'bookings.read', 'bookings.write', 'bookings.cancel',
    'orders.read', 'orders.write',
    'tickets.read', 'tickets.write',
    'customers.read',
    'conversations.takeover',
    'metrics.read',
    'audit.read',
    'staff.read',
  ],
  SUPER_ADMIN: [
    'services.read', 'services.write',
    'bookings.read', 'bookings.write', 'bookings.cancel',
    'orders.read', 'orders.write',
    'tickets.read', 'tickets.write',
    'customers.read',
    'conversations.takeover',
    'staff.read', 'staff.write',
    'audit.read',
    'metrics.read',
  ],
};

export function can(role: Role | undefined | null, permission: Permission): boolean {
  if (!role) return false;
  return MATRIX[role]?.includes(permission) ?? false;
}

export class AuthorizationError extends Error {
  constructor(public permission: Permission) {
    super(`صلاحية مرفوضة: ${permission}`);
    this.name = 'AuthorizationError';
  }
}

export function requirePermission(role: Role | undefined | null, permission: Permission): void {
  if (!can(role, permission)) throw new AuthorizationError(permission);
}

export function roleLabelAr(role: Role): string {
  return { SUPER_ADMIN: 'مشرف أعلى', ADMIN: 'مدير نظام', MANAGER: 'مدير', STAFF: 'موظف' }[role];
}

export function parseRole(raw: string): Role | null {
  const up = raw.trim().toUpperCase().replace('-', '_');
  return (ROLES as string[]).includes(up) ? (up as Role) : null;
}
