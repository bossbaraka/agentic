/**
 * خدمة الإدارة — كل العمليات الإدارية تمر هنا: RBAC + مستودعات + تدقيق.
 * لا يصل التطبيق للمستودعات مباشرة من موجهات تيليجرام.
 */
import { addAdmin, getAdminByTelegramId, listAdmins, setAdminActive } from '../db/repos/users.js';
import { bookingCounts, getBookingByRef, listBookingsAdmin } from '../db/repos/bookings.js';
import { audit, listAudit, metricsSummary } from '../db/repos/system.js';
import { countUsers, listCustomers } from '../db/repos/users.js';
import { can, requirePermission, roleLabelAr, type Permission, parseRole } from './rbac.js';
import type { AdminRow, Role } from '../db/types.js';
import { bookingService } from './bookingService.js';
import { orderService } from './orderService.js';
import { ticketService } from './ticketService.js';
import { handoffService } from './handoffService.js';
import { catalogService } from './catalogService.js';
import { ServiceError } from './errors.js';
import type { BookingStatus } from '../db/types.js';

export const adminService = {
  resolveByTelegramId(telegramId: string): AdminRow | undefined {
    return getAdminByTelegramId(telegramId);
  },

  guard(admin: AdminRow | undefined, permission: Permission): AdminRow {
    if (!admin) throw new ServiceError('forbidden', 'هذه الميزة للموظفين فقط.');
    requirePermission(admin.role, permission);
    return admin;
  },

  can(admin: AdminRow | undefined, permission: Permission): boolean {
    return Boolean(admin && can(admin.role, permission));
  },

  stats(admin: AdminRow) {
    this.guard(admin, 'metrics.read');
    return { ...metricsSummary(), bookings: { ...metricsSummary().bookings, ...bookingCounts() }, users: countUsers() };
  },

  // ───────── الموظفون ─────────

  staffList(admin: AdminRow): AdminRow[] {
    this.guard(admin, 'staff.read');
    return listAdmins(true);
  },

  addStaff(admin: AdminRow, telegramId: string, roleRaw: string, meta: { username?: string; displayName?: string } = {}): AdminRow {
    this.guard(admin, 'staff.write');
    const role = parseRole(roleRaw);
    if (!role) throw new ServiceError('validation', `الدور غير معروف. الأدوار: SUPER_ADMIN, ADMIN, MANAGER, STAFF`);
    if (role === 'SUPER_ADMIN' && admin.role !== 'SUPER_ADMIN') {
      throw new ServiceError('forbidden', 'المشرف الأعلى يُعيّنه مشرف أعلى فقط.');
    }
    const { created, admin: row } = addAdmin({
      telegramId: String(telegramId), role, username: meta.username ?? null, displayName: meta.displayName ?? null, createdBy: admin.id,
    });
    audit({ actorType: 'admin', actorId: String(admin.id), action: created ? 'staff.add' : 'staff.update', entity: 'admin', entityId: String(row.id), meta: { role } });
    return row;
  },

  removeStaff(admin: AdminRow, telegramId: string): void {
    this.guard(admin, 'staff.write');
    const target = getAdminByTelegramId(telegramId);
    if (!target) throw new ServiceError('not_found', 'لا يوجد موظف بهذا المعرّف');
    if (target.id === admin.id) throw new ServiceError('conflict', 'لا يمكنك تعطيل حسابك بنفسك');
    setAdminActive(target.id, false);
    audit({ actorType: 'admin', actorId: String(admin.id), action: 'staff.deactivate', entity: 'admin', entityId: String(target.id) });
  },

  // ───────── الحجوزات ─────────

  bookings(admin: AdminRow, opts: { status?: BookingStatus | 'all'; limit?: number; offset?: number }) {
    this.guard(admin, 'bookings.read');
    return listBookingsAdmin(opts);
  },

  setBookingStatus(admin: AdminRow, ref: string, status: BookingStatus) {
    this.guard(admin, status === 'CANCELLED' ? 'bookings.cancel' : 'bookings.write');
    return bookingService.adminChangeStatus(admin, ref, status);
  },

  booking(admin: AdminRow, ref: string) {
    this.guard(admin, 'bookings.read');
    const b = getBookingByRef(ref);
    if (!b) throw new ServiceError('not_found', 'الحجز غير موجود');
    return b;
  },

  // ───────── الطلبات والتذاكر ─────────

  orders(admin: AdminRow, status?: string) {
    this.guard(admin, 'orders.read');
    return orderService.adminList({ status, limit: 10 });
  },

  setOrderStatus(admin: AdminRow, ref: string, status: 'PENDING' | 'CONFIRMED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED') {
    this.guard(admin, 'orders.write');
    return orderService.setStatus(admin.id, ref, status);
  },

  tickets(admin: AdminRow, status?: string) {
    this.guard(admin, 'tickets.read');
    return ticketService.adminList({ status, limit: 10 });
  },

  setTicketStatus(admin: AdminRow, ref: string, status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED', resolution?: string) {
    this.guard(admin, 'tickets.write');
    return ticketService.setStatus(admin.id, ref, status, resolution);
  },

  // ───────── العملاء والاستلام والمحفوظات ─────────

  customers(admin: AdminRow) {
    this.guard(admin, 'customers.read');
    return listCustomers(30);
  },

  takeover(admin: AdminRow, contactKey: string): void {
    this.guard(admin, 'conversations.takeover');
    handoffService.takeover(admin, contactKey);
  },

  resume(contactKey: string): void {
    handoffService.resume(contactKey);
  },

  auditLog(admin: AdminRow, limit = 20) {
    this.guard(admin, 'audit.read');
    return listAudit({ limit });
  },

  services(admin: AdminRow) {
    this.guard(admin, 'services.read');
    return catalogService.adminList();
  },

  setServiceStatus(admin: AdminRow, idOrSlug: string, status: 'active' | 'inactive' | 'hidden') {
    this.guard(admin, 'services.write');
    return catalogService.setStatus(admin.id, idOrSlug, status);
  },

  setServicePrice(admin: AdminRow, idOrSlug: string, price: number | null) {
    this.guard(admin, 'services.write');
    return catalogService.setPrice(admin.id, idOrSlug, price);
  },

  roleLabel(role: Role): string {
    return roleLabelAr(role);
  },
};
