/**
 * فحص سريع مباشر لأدوات نظام الحجوزات (نفس مسار runTool).
 * التشغيل: npx tsx scripts/booking-smoke.ts
 */
import { runTool } from '../src/agent/tools.js';
import { availableSlotsForDate, nextAvailableDays, formatAvailabilityText } from '../src/agent/bookings.js';

const ctx = { sessionKey: '972590000077', customerName: 'خالد عمر' };

function line(title: string) {
  console.log(`\n━━━ ${title} ━━━`);
}

async function main() {
  line('معلومات النشاط (ساعات العمل)');
  console.log(formatAvailabilityText());
  console.log((await runTool('get_restaurant_info', {}, ctx)).userMessage);

  line('القائمة (المنتجات/الباقات)');
  console.log((await runTool('get_menu', {}, ctx)).userMessage);

  line('أقرب أيام متاحة (بدون تاريخ)');
  const noDate = await runTool('check_availability', {}, ctx);
  console.log(noDate.userMessage);

  // نختار أول يوم متاح فعليًا لتجربة دورة كاملة
  const next = nextAvailableDays(1);
  const day = next[0];
  const slot = day?.slots[0];
  console.log(`\nسنجرّب: ${day?.date} ${slot} (${day?.dayName})`);

  if (!day || !slot) {
    console.log('لا توجد فتحات متاحة ضمن المدى — تخطي دورة الحجز.');
    process.exit(0);
  }

  line('فحص التوفر لفتحة محددة');
  console.log((await runTool('check_availability', { date: day.date, time: slot }, ctx)).userMessage);

  line('إنشاء حجز');
  const created = await runTool('create_booking', {
    service: 'pro', date: day.date, time: slot,
    full_name: 'خالد عمر', restaurant_name: 'مطعم الأصالة', city: 'الناصرة', tables: 25,
  }, ctx);
  console.log(created.userMessage);
  const ref = (created.data as any)?.ref;
  console.log('sideEffect to manager:', (created as any).sideEffect?.kind);

  line('إنشاء حجز ثانٍ في نفس الفتحة (يجب أن يفشل — الفتحة محجوزة)');
  const dup = await runTool('create_booking', {
    service: 'starter', date: day.date, time: slot, full_name: 'عميل آخر',
  }, ctx);
  console.log('ok =', dup.ok, '|', dup.userMessage);

  line('بيانات العميل + حجوزاته');
  console.log((await runTool('get_customer', {}, ctx)).userMessage);

  // نعدّل لوقت آخر متاح إن وُجد
  const alt = day.slots[1];
  if (ref && alt) {
    line(`تعديل الحجز إلى ${day.date} ${alt}`);
    const upd = await runTool('update_booking', { booking_ref: ref, date: day.date, time: alt }, ctx);
    console.log(upd.userMessage);
    console.log('ok =', upd.ok);
  }

  line('إلغاء الحجز');
  if (ref) {
    const canc = await runTool('cancel_booking', { booking_ref: ref, reason: 'تأجيل الافتتاح' }, ctx);
    console.log(canc.userMessage);
    console.log('ok =', canc.ok);
  }

  line('إلغاء حجز غير موجود (يجب أن يفشل)');
  const noBk = await runTool('cancel_booking', { booking_ref: 'BKG-ZZZZZZ' }, ctx);
  console.log('ok =', noBk.ok, '|', noBk.userMessage);

  line('تنبيه داخلي');
  const notif = await runTool('send_notification', { message: 'متابعة حجز العميل خالد', to: 'human', priority: 'high' }, ctx);
  console.log('ok =', notif.ok, '| sideEffect =', (notif as any).sideEffect?.kind);
}

main().catch((e) => { console.error(e); process.exit(1); });
