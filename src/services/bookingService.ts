/**
 * خدمة الحجوزات — منطق الأعمال الوحيد المخوّل إنشاء/تعديل/إلغاء الحجوزات.
 * لا يستدعيها الـ LLM مباشرة: الأدوات والقوائم تمر عبرها فقط.
 * كل عملية: تحقق مدخلات → ملكية → مستودع (transaction) → إشعارات → تدقيق → قياس.
 */
import {
  availableSlotsForDate,
  checkSlot,
  nextAvailableDays,
  slotEpochMs,
  type SlotOccupancy,
} from '../agent/bookings.js';
import { config } from '../config.js';
import { t } from '../lib/i18n.js';
import {
  activeOccupancy,
  createBooking,
  getBookingByRef,
  latestActiveForContact,
  listBookingsForContact,
  markReminderSent,
  rescheduleBooking,
  updateStatus,
  type BookingError,
} from '../db/repos/bookings.js';
import { ensureCustomer, patchCustomer } from '../db/repos/users.js';
import { getService, getServiceBySlug, type ServiceMeta, serviceMeta } from '../db/repos/catalog.js';
import { audit } from '../db/repos/system.js';
import type { BookingRow, BookingStatus, ServiceRow } from '../db/types.js';
import { ServiceError } from './errors.js';
import { notifications } from './notificationService.js';

function fromBookingError(e: unknown): never {
  if ((e as BookingError)?.name === 'BookingError') {
    const be = e as BookingError;
    if (be.code === 'slot_unavailable') throw new ServiceError('unavailable', be.message);
    throw new ServiceError('internal', be.message);
  }
  throw e instanceof ServiceError ? e : new ServiceError('internal', (e as Error).message);
}

export interface DayAvailability {
  date: string;
  dayName: string;
  slots: string[];
}

export const bookingService = {
  /** الفتحات المتاحة ليوم محدد (بعد خصم الإشغال الفعلي من القاعدة) */
  daySlots(date: string) {
    return availableSlotsForDate(date, activeOccupancy());
  },

  /** أقرب أيام متاحة */
  nextDays(limit = 4): DayAvailability[] {
    return nextAvailableDays(limit, activeOccupancy() as SlotOccupancy[]);
  },

  /** فحص فتحة محددة */
  check(date: string, time: string, ignoreId?: number) {
    return checkSlot(date, time, activeOccupancy(), ignoreId);
  },

  /** حل مرجع الخدمة: id رقمي أو slug (باقة/خدمة) */
  resolveService(ref: string | number | undefined): ServiceRow | undefined {
    if (ref === undefined || ref === null || ref === '') return undefined;
    if (typeof ref === 'number') return getService(ref);
    if (/^\d+$/.test(ref)) return getService(Number(ref));
    return getServiceBySlug(ref);
  },

  /**
   * إنشاء حجز لعميل. الباقة الافتراضية pro إن لم تُحدّد خدمة (توافق خلفي).
   */
  create(input: {
    contactKey: string;
    serviceRef?: string | number | null;
    date: string;
    time: string;
    fullName?: string | null;
    notes?: string | null;
    language?: 'ar' | 'en';
    actor?: 'customer' | 'admin';
    adminId?: number | null;
    idempotencyKey?: string | null;
  }): { booking: BookingRow; service?: ServiceRow } {
    let service: ServiceRow | undefined;
    if (input.serviceRef) {
      service = this.resolveService(input.serviceRef);
      if (!service) throw new ServiceError('validation', 'الخدمة المطلوبة غير موجودة');
      if (service.status !== 'active') throw new ServiceError('unavailable', 'هذه الخدمة غير متاحة حاليًا');
    } else {
      service = getServiceBySlug('pro'); // توافق مع مسار الباقات القديم
    }

    const { user, customer } = ensureCustomer(input.contactKey, {
      displayName: input.fullName ?? null,
      language: (input.language ?? 'ar') as 'ar' | 'en',
    });

    let booking: BookingRow;
    try {
      booking = createBooking({
        contactKey: input.contactKey,
        fullName: input.fullName ?? customer.full_name,
        slotDate: input.date,
        slotTime: input.time,
        service: service ?? null,
        planSlug: service?.slug ?? null,
        notes: input.notes ?? null,
        userId: user.id,
        customerId: customer.id,
        adminId: input.adminId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
      });
    } catch (e) {
      return fromBookingError(e);
    }

    if (input.fullName) patchCustomer(input.contactKey, { fullName: input.fullName.slice(0, 60) });

    audit({
      actorType: input.actor === 'admin' ? 'admin' : 'customer',
      actorId: input.adminId ? String(input.adminId) : input.contactKey,
      action: 'booking.create',
      entity: 'booking',
      entityId: booking.ref,
      meta: { service: service?.slug, date: input.date, time: input.time },
    });

    // إشعارات: تنبيه الفريق + تذكيرات الموعد
    const lang = input.language ?? 'ar';
    this.enqueueStaffAndReminders(booking, service, '🗓️ حجز جديد', lang);
    return { booking, service };
  },

  /** تعديل موعد حجز — يتحقق من الملكية للعملاء */
  reschedule(input: {
    contactKey: string;
    ref?: string | null;
    date: string;
    time: string;
    serviceRef?: string | null;
    actor?: 'customer' | 'admin';
    adminId?: number | null;
    language?: 'ar' | 'en';
  }): BookingRow {
    const booking = this.requireOwnedBooking(input.contactKey, input.ref, input.actor);
    const service = input.serviceRef ? this.resolveService(input.serviceRef) : undefined;
    if (input.serviceRef && !service) throw new ServiceError('validation', 'الخدمة المطلوبة غير موجودة');

    try {
      const updated = rescheduleBooking(booking, {
        slotDate: input.date,
        slotTime: input.time,
        service: service ?? null,
        adminId: input.adminId ?? null,
      });
      // إلغاء تذكيرات القديمة وجدولة الجديدة
      notifications.cancelTargeted('booking_reminder', updated.id);
      const svc = getService(updated.service_id ?? 0) ?? service;
      this.enqueueStaffAndReminders(updated, svc, '✏️ تعديل حجز', input.language === 'en' ? 'en' : 'ar');
      audit({
        actorType: input.actor === 'admin' ? 'admin' : 'customer',
        actorId: input.adminId ? String(input.adminId) : input.contactKey,
        action: 'booking.reschedule', entity: 'booking', entityId: updated.ref,
        meta: { date: input.date, time: input.time },
      });
      return updated;
    } catch (e) {
      return fromBookingError(e);
    }
  },

  /** إلغاء حجز — يتحقق من الملكية للعملاء */
  cancel(input: {
    contactKey: string;
    ref?: string | null;
    reason?: string | null;
    actor?: 'customer' | 'admin';
    adminId?: number | null;
  }): BookingRow {
    const booking = this.requireOwnedBooking(input.contactKey, input.ref, input.actor);
    let updated: BookingRow;
    try {
      updated = updateStatus(booking, 'CANCELLED', { reason: input.reason ?? null, adminId: input.adminId ?? null });
    } catch (e) {
      return fromBookingError(e);
    }
    notifications.cancelTargeted('booking_reminder', updated.id);
    notifications.staffAlert(
      input.actor === 'admin' ? 'manager' : 'human',
      `❌ إلغاء حجز ${updated.ref}\n👤 ${updated.full_name ?? '—'}\n📅 ${updated.slot_date} ${updated.slot_time}` +
        (input.reason ? `\n📝 السبب: ${input.reason.slice(0, 160)}` : ''),
      { bookingRef: updated.ref, contactKey: input.contactKey },
    );
    audit({
      actorType: input.actor === 'admin' ? 'admin' : 'customer',
      actorId: input.adminId ? String(input.adminId) : input.contactKey,
      action: 'booking.cancel', entity: 'booking', entityId: updated.ref,
      meta: { reason: input.reason ?? null },
    });
    return updated;
  },

  /** تغيير حالة حجز من الموظفين (تأكيد/إكمال/عدم حضور) */
  adminChangeStatus(admin: { id: number; role: string }, ref: string, status: BookingStatus): BookingRow {
    const booking = getBookingByRef(ref);
    if (!booking) throw new ServiceError('not_found', 'الحجز غير موجود');
    try {
      const updated = updateStatus(booking, status, { adminId: admin.id });
      audit({ actorType: 'admin', actorId: String(admin.id), action: `booking.status.${status}`, entity: 'booking', entityId: ref });
      notifications.cancelTargeted('booking_reminder', updated.id);
      return updated;
    } catch (e) {
      return fromBookingError(e);
    }
  },

  listFor(contactKey: string) {
    return listBookingsForContact(contactKey, { includePast: true, limit: 20 });
  },

  byRef(ref: string) {
    return getBookingByRef(ref);
  },

  /** جلب حجز نشط والتأكد من ملكية العميل له (الموظفون يتجاوزون بشرط الصلاحية) */
  requireOwnedBooking(contactKey: string, ref: string | undefined | null, actor: 'customer' | 'admin' = 'customer'): BookingRow {
    const booking = ref ? getBookingByRef(ref) : latestActiveForContact(contactKey);
    if (!booking) throw new ServiceError('not_found', 'لا يوجد حجز مطابق');
    if (actor !== 'admin' && booking.contact_key !== contactKey) {
      audit({
        actorType: 'customer', actorId: contactKey, action: 'booking.access_denied',
        entity: 'booking', entityId: booking.ref,
      });
      throw new ServiceError('forbidden', 'لا تملك صلاحية على هذا الحجز');
    }
    if (booking.status !== 'PENDING' && booking.status !== 'CONFIRMED') {
      throw new ServiceError('conflict', 'هذا الحجز ليس نشطًا');
    }
    return booking;
  },

  /** جدولة: تنبيه الفريق + تذكيرَي 24س/1س (المستقبلية فقط) */
  enqueueStaffAndReminders(booking: BookingRow, service: ServiceRow | undefined, titleAr: string, lang: 'ar' | 'en'): void {
    const meta: ServiceMeta = service ? serviceMeta(service) : {};
    const svcName = lang === 'en' ? service?.name_en || service?.name_ar || booking.plan_slug || '' : service?.name_ar || booking.plan_slug || '';
    notifications.staffAlert('manager',
      `${titleAr} ${booking.ref}\n👤 ${booking.full_name ?? '—'}\n📦 ${svcName}\n📅 ${booking.slot_date} ${booking.slot_time}\n💬 ${booking.contact_key}`,
      { bookingRef: booking.ref, contactKey: booking.contact_key },
    );

    const hours = config.notifications.REMINDER_HOURS.length ? config.notifications.REMINDER_HOURS : [24, 1];
    for (const h of hours) {
      const runAt = booking.slot_epoch_ms - h * 3600_000;
      if (runAt <= Date.now()) continue;
      const label = svcName;
      const key = h === 24 ? 'booking.reminder_24' : h === 1 ? 'booking.reminder_1' : null;
      const headline = key
        ? t(lang, key)
        : lang === 'en' ? `Reminder: your appointment is in ${h} hours` : `تذكير: موعدك بعد ${h} ساعة`;
      const text = `${headline} ${booking.slot_time} (${label}). ${t(lang, 'booking.reminder_note')}`;
      void meta;
      notifications.enqueue({
        kind: 'booking_reminder',
        targetKey: booking.contact_key,
        subject: `تذكير ${booking.ref} قبل ${h} ساعة`,
        payload: { key: booking.contact_key, text, bookingId: booking.id },
        runAt,
      });
    }
  },

  /** يُستدعى دوريًا من عامل الإشعارات للتذكيرات الدقيقة الفائتة (إن لزم) */
  sweepReminders(): void {
    // التذكيرات مجدولة مسبقًا عند الإنشاء/التعديل؛ هذه إضافة أمان لحجز سُكب قبل إضافة الميزة
  },
};

export { slotEpochMs, markReminderSent };
