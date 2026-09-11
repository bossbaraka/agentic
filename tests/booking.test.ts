import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/db.js';
import { bookingService } from '../src/services/bookingService.js';
import { ServiceError } from '../src/services/errors.js';
import { countAt, getBookingByRef, listBookingsAdmin, listBookingsForContact } from '../src/db/repos/bookings.js';
import { all } from '../src/db/client.js';
import { config } from '../src/config.js';
import type { NotificationRow } from '../src/db/types.js';

// نحسب الأيام مرة واحدة قبل أي حجز حتى لا تزحف الفهارس بعد الامتلاء
const DAYS = bookingService.nextDays(60).filter((d) => d.slots.length >= 2);
/** اليوم المتاح رقم dayIdx (أيام منفصلة لكل اختبار لتفادي التزاحم) */
function firstSlot(dayIdx = 0, slotIdx = 0) {
  const day = DAYS[dayIdx]!;
  return { date: day.date, time: day.slots[slotIdx]!, day };
}

describe('محرك الحجوزات', () => {
  before(() => {
    // نبدأ من حالة إشغال نظيفة
    for (const b of listBookingsAdmin({ status: 'all', limit: 500 }).rows) {
      if (b.status === 'PENDING' || b.status === 'CONFIRMED') {
        bookingService.cancel({ contactKey: b.contact_key, ref: b.ref, reason: 'تنظيف اختبار' });
      }
    }
  });

  it('ينشئ حجزًا بحالة CONFIRMED ويسجّل إشغال الفتحة', () => {
    const { date, time } = firstSlot(0);
    const r = bookingService.create({
      contactKey: 'tg:aaa', serviceRef: 'pro', date, time, fullName: 'عميل أ', language: 'ar',
      idempotencyKey: 't1',
    });
    assert.equal(r.booking.status, 'CONFIRMED');
    assert.equal(countAt(date, time), 1);
  });

  it('يمنع الحجز المزدوج على نفس الفتلة (القيد الحرج)', () => {
    const { date, time } = firstSlot(1);
    bookingService.create({
      contactKey: 'tg:owner1', serviceRef: 'pro', date, time, fullName: 'المالك', language: 'ar',
      idempotencyKey: `race-${date}-${time}`,
    });
    assert.throws(
      () => bookingService.create({
        contactKey: 'tg:owner2', serviceRef: 'starter', date, time, fullName: 'المتزاحم', language: 'ar',
        idempotencyKey: `race2-${date}-${time}`,
      }),
      (e: unknown) => e instanceof ServiceError && /محجوز|مكتمل|متاحة/.test(e.message),
    );
    assert.equal(countAt(date, time), 1);
  });

  it('idempotent: نفس المفتاح يعيد نفس الحجز بلا صف جديد', () => {
    const { date, time } = firstSlot(2);
    const a = bookingService.create({
      contactKey: 'tg:idem', serviceRef: 'pro', date, time, language: 'ar', idempotencyKey: 'same-key-1',
    }).booking;
    const b = bookingService.create({
      contactKey: 'tg:idem', serviceRef: 'pro', date, time, language: 'ar', idempotencyKey: 'same-key-1',
    }).booking;
    assert.equal(a.id, b.id);
  });

  it('يرفض التواريخ والأوقات غير الصالحة قبل لمس قاعدة البيانات', () => {
    assert.throws(
      () => bookingService.create({ contactKey: 'tg:bad', serviceRef: 'pro', date: '2026-13-40', time: '99:99', language: 'ar' }),
      (e: unknown) => e instanceof ServiceError,
    );
  });

 it('يرفض خدمة/باقة غير موجودة', () => {
    const { date, time } = firstSlot();
    assert.throws(
      () => bookingService.create({ contactKey: 'tg:bad2', serviceRef: 'ghost-plan', date, time, language: 'ar' }),
      (e: unknown) => e instanceof ServiceError,
    );
  });

  it('ملكية: لا يحق لعميل إلغاء/تعديل حجز غيره', () => {
    const { date, time } = firstSlot(3);
    const { booking } = bookingService.create({
      contactKey: 'tg:real-owner', serviceRef: 'pro', date, time, language: 'ar', idempotencyKey: 'own-1',
    });
    assert.throws(() => bookingService.cancel({ contactKey: 'tg:intruder', ref: booking.ref }), ServiceError);
    assert.throws(
      () => bookingService.reschedule({ contactKey: 'tg:intruder', ref: booking.ref, date, time }),
      ServiceError,
    );
    // الحجز بقي سليمًا
    assert.equal(getBookingByRef(booking.ref)?.status, 'CONFIRMED');
  });

  it('دورة الحياة: تعديل يلغي تذكيرات القديمة ويحرّر الفتحة القديمة، ثم إلغاء يحرّر الفتحة', () => {
    const day = DAYS[5]!;
    const t1 = day.slots[0]!;
    const t2 = day.slots[1]!;
    const { booking } = bookingService.create({
      contactKey: 'tg:life', serviceRef: 'pro', date: day.date, time: t1, language: 'ar', idempotencyKey: 'life-1',
    });
    assert.equal(countAt(day.date, t1), 1);
    const moved = bookingService.reschedule({ contactKey: 'tg:life', ref: booking.ref, date: day.date, time: t2, language: 'ar' });
    assert.equal(moved.slot_time, t2);
    assert.equal(countAt(day.date, t1), 0);
    assert.equal(countAt(day.date, t2), 1);

    // تذكيرات الفتحة القديمة أُلغيت والجديدة جُدولت على وقت الفتحة الجديدة
    const reminders = all<NotificationRow>(
      "SELECT * FROM notifications WHERE kind = 'booking_reminder' AND json_extract(payload, '$.bookingId') = ?",
      [moved.id],
    );
    const pending = reminders.filter((r) => r.status === 'PENDING');
    assert.ok(reminders.some((r) => r.status === 'CANCELLED'), 'يجب إلغاء تذكيرات الفتحة القديمة');
    assert.ok(pending.length >= 1, 'يجب جدولة تذكيرات للفتحة الجديدة');
    assert.ok(pending.every((r) => r.run_at >= moved.slot_epoch_ms - 25 * 3_600_000));

    const cancelled = bookingService.cancel({ contactKey: 'tg:life', ref: booking.ref, reason: 'من الاختبار' });
    assert.equal(cancelled.status, 'CANCELLED');
    assert.ok(cancelled.cancellation_reason);
    assert.equal(countAt(day.date, t2), 0);

    // لا يمكن إلغاء حجز ملغى مرتين
    assert.throws(() => bookingService.cancel({ contactKey: 'tg:life', ref: booking.ref }), ServiceError);
  });

  it('يجدول تذكيرات الموعد (24س/1س أو إعدادات البيئة) في طابور الإشعارات', () => {
    // أبعد يوم متاح لضمان وقوع كل التذكيرات في المستقبل
    const far = DAYS[DAYS.length - 1]!;
    const { booking } = bookingService.create({
      contactKey: 'tg:reminder', serviceRef: 'pro', date: far.date, time: far.slots[0]!, language: 'ar',
      idempotencyKey: 'reminder-1',
    });
    const rows = all<NotificationRow>(
      "SELECT * FROM notifications WHERE kind = 'booking_reminder' AND json_extract(payload, '$.bookingId') = ?",
      [booking.id],
    );
    const expectedHours = config.notifications.REMINDER_HOURS.filter((h) => booking.slot_epoch_ms - h * 3_600_000 > Date.now());
    assert.equal(rows.length, expectedHours.length);
    for (const h of expectedHours) {
      const row = rows.find((r) => r.subject.includes(`قبل ${h} ساعة`));
      assert.ok(row, `تذكير ${h} ساعة مفقود`);
      assert.equal(row.status, 'PENDING');
      assert.equal(row.run_at, booking.slot_epoch_ms - h * 3_600_000);
    }
  });

  it('قوائم العميل لا تُظهر حجوزات غيره', () => {
    const { date, time } = firstSlot(5);
    bookingService.create({ contactKey: 'tg:visible-me', serviceRef: 'pro', date, time, language: 'ar', idempotencyKey: 'vis-1' });
    const rows = listBookingsForContact('tg:visible-me');
    assert.ok(rows.length >= 1);
    assert.ok(rows.every((b) => b.contact_key === 'tg:visible-me'));
  });
});
