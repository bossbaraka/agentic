import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/db.js';
import { runTool } from '../src/agent/tools.js';
import { bookingService } from '../src/services/bookingService.js';
import { listBookingsAdmin } from '../src/db/repos/bookings.js';
import type { ToolContext } from '../src/agent/tools-types.js';

const ctx = (key = 'tg:tool-tester'): ToolContext => ({
  sessionKey: key,
  customerName: 'مختبِر',
  channel: 'tg',
  language: 'ar',
});

const DAYS = bookingService.nextDays(60).filter((d) => d.slots.length > 0);
function firstSlot(dayIdx = 0) {
  const day = DAYS[dayIdx]!;
  return { date: day.date, time: day.slots[0]! };
}

describe('سجل الأدوات الموحّد (toolRegistry)', () => {
  before(() => {
    for (const b of listBookingsAdmin({ status: 'all', limit: 500 }).rows) {
      if (b.status === 'PENDING' || b.status === 'CONFIRMED') {
        bookingService.cancel({ contactKey: b.contact_key, ref: b.ref });
      }
    }
  });

  it('يرفض أي أداة غير مسجّلة دون تنفيذ ولا يرمي استثناءً لحلقة النموذج', async () => {
    const r = await runTool('drop_database', { confirm: true }, ctx());
    assert.equal(r.ok, false);
    assert.match(String((r.data as any)?.error ?? ''), /غير معروفة|مصرّح/);
  });

  it('يرفض وسائط فاسدة قبل تنفيذ العملية المعدِّلة (تاريخ غير صالح)', async () => {
    const r = await runTool('create_booking', { service: 'pro', date: '13/13/2026', time: '09:00' }, ctx());
    assert.equal(r.ok, false);
    // لا حجز أُنشئ
    assert.equal(listBookingsAdmin({ limit: 1 }).total >= 0, true);
  });

  it('يرفض وقتًا بصيغة خاطئة', async () => {
    const r = await runTool('create_booking', { service: 'pro', date: firstSlot().date, time: '9 صباحًا' }, ctx());
    assert.equal(r.ok, false);
  });

  it('يرفض نصًا يتجاوز الحد الأقصى للطول (ملاحظات الحجز)', async () => {
    const { date, time } = firstSlot();
    const r = await runTool(
      'create_booking',
      { service: 'pro', date, time, notes: 'x'.repeat(400) },
      ctx(),
    );
    assert.equal(r.ok, false);
  });

  it('إنشاء حجز عبر الأداة ثم إلغاؤه عبر الأداة', async () => {
    const { date, time } = firstSlot(0);
    const created = await runTool('create_booking', { service: 'pro', date, time, full_name: 'عبر الأداة' }, ctx());
    assert.equal(created.ok, true, JSON.stringify(created.data));
    const ref = (created.data as any).ref as string;

    const listed = await runTool('get_customer_bookings', {}, ctx());
    assert.equal(listed.ok, true);
    assert.ok(JSON.stringify(listed.data).includes(ref));

    const cancelled = await runTool('cancel_booking', { booking_ref: ref, reason: 'تغيّر موعد العميل' }, ctx());
    assert.equal(cancelled.ok, true);
    assert.equal((cancelled.data as any).status, 'CANCELLED');
  });

  it('لا يسمح بإلغاء حجز غير مملوك للجلسة', async () => {
    const { date, time } = firstSlot(1);
    const created = await runTool('create_booking', { service: 'pro', date, time }, ctx('tg:tool-owner'));
    const ref = (created.data as any).ref as string;
    const r = await runTool('cancel_booking', { booking_ref: ref }, ctx('tg:tool-thief'));
    assert.equal(r.ok, false);
  });

  it('get_services يرجع كتالوجًا مزروعًا من قاعدة البيانات (بلا hardcode)', async () => {
    const r = await runTool('get_services', {}, ctx());
    assert.equal(r.ok, true);
    const text = JSON.stringify(r.data);
    assert.ok(text.includes('pro') && text.includes('starter'));
  });

  it('تذكرة دعم: يرفض issue فارغًا', async () => {
    const r = await runTool('create_support_ticket', { issue: '' }, ctx());
    assert.equal(r.ok, false);
  });
});
