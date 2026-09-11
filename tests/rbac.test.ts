import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/db.js';
import { adminService } from '../src/services/adminService.js';
import { addAdmin } from '../src/db/repos/users.js';
import { getServiceBySlug } from '../src/db/repos/catalog.js';
import { bookingService } from '../src/services/bookingService.js';
import { AuthorizationError } from '../src/services/rbac.js';
import { can } from '../src/services/rbac.js';

const superId = '900000001';
const managerId = '900000002';
const staffId = '900000003';
const outsiderId = '900000004';

describe('RBAC وصلاحيات الموظفين', () => {
  before(() => {
    addAdmin({ telegramId: superId, role: 'SUPER_ADMIN', displayName: 'مشرف أعلى' });
    addAdmin({ telegramId: managerId, role: 'MANAGER', displayName: 'مدير' });
    addAdmin({ telegramId: staffId, role: 'STAFF', displayName: 'موظف' });
  });

  it('غير الموظف لا يُحَل إلى أي دور', () => {
    assert.equal(adminService.resolveByTelegramId(outsiderId), undefined);
  });

  it('مصفوفة الصلاحيات: STAFF يقرأ لكن لا يدير الموظفين ولا يوقف الخدمات', () => {
    assert.equal(can('STAFF', 'bookings.read'), true);
    assert.equal(can('STAFF', 'staff.write'), false);
    assert.equal(can('STAFF', 'services.write'), false);
    assert.equal(can('STAFF', 'metrics.read'), true);
    assert.equal(can('STAFF', 'audit.read'), false);
    assert.equal(can('MANAGER', 'bookings.write'), true);
    assert.equal(can('MANAGER', 'staff.write'), false);
    assert.equal(can('SUPER_ADMIN', 'staff.write'), true);
  });

  it('إضافة موظف: SUPER_ADMIN ينجح، STAFF يُرفض', () => {
    const sup = adminService.resolveByTelegramId(superId)!;
    const staff = adminService.resolveByTelegramId(staffId)!;
    const created = adminService.addStaff(sup, '900000099', 'STAFF');
    assert.equal(created.role, 'STAFF');
    assert.throws(() => adminService.addStaff(staff, '900000088', 'ADMIN'), AuthorizationError);
    // ولا يحق للموظف رفع رتبته أو إضافة مدير
    assert.throws(() => adminService.addStaff(staff, '900000077', 'MANAGER'), AuthorizationError);
  });

  it('تعطيل خدمة محجوز عليها: SUPER_ADMIN فقط', () => {
    const sup = adminService.resolveByTelegramId(superId)!;
    const staff = adminService.resolveByTelegramId(staffId)!;
    assert.throws(() => adminService.setServiceStatus(staff, 'pro', 'inactive'), AuthorizationError);
    const row = adminService.setServiceStatus(sup, 'pro', 'inactive');
    assert.equal(row.status, 'inactive');
    // أعد التفعيل حتى لا تتأثر بقية الاختبارات المنفصلة (قاعدة بيانات مختلفة لكل ملف)
    adminService.setServiceStatus(sup, 'pro', 'active');
    assert.equal(getServiceBySlug('pro')?.status, 'active');
  });

  it('تغيير حالة حجز: MANAGER يقدر، STAFF حسب المصفوفة', () => {
    const day = bookingService.nextDays(60).filter((d) => d.slots.length > 1)[0]!;
    const { booking } = bookingService.create({
      contactKey: 'tg:rbac-cust', serviceRef: 'starter', date: day.date, time: day.slots[0]!, language: 'ar',
    });
    const manager = adminService.resolveByTelegramId(managerId)!;
    const staff = adminService.resolveByTelegramId(staffId)!;
    const completed = adminService.setBookingStatus(manager, booking.ref, 'COMPLETED');
    assert.equal(completed.status, 'COMPLETED');
    // موظف عادي لا يملك bookings.write
    const { booking: b2 } = bookingService.create({
      contactKey: 'tg:rbac-cust2', serviceRef: 'starter', date: day.date, time: day.slots[1]!, language: 'ar',
    });
    if (!can('STAFF', 'bookings.write')) {
      assert.throws(() => adminService.setBookingStatus(staff, b2.ref, 'COMPLETED'), AuthorizationError);
    }
  });
});
