/**
 * اختبار دخان لمسار قوائم تيليجرام الكامل عبر /internal/simulate:
 * /start ← الخدمات ← فئة ← خدمة ← حجز (تاريخ/وقت/تأكيد) ← منع الحجز المزدوج.
 */
import { catalogService } from '../src/services/catalogService.js';
import { bookingService } from '../src/services/bookingService.js';
import { listBookingsForContact, activeOccupancy } from '../src/db/repos/bookings.js';

const BASE = process.env.BASE ?? 'http://localhost:3999';
let uid = 1_000_000;

function tgMessage(chatId: string, text: string) {
  return {
    channel: 'tg',
    update: {
      update_id: ++uid,
      message: {
        message_id: ++uid,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: 'private', first_name: 'اختبار' },
        from: { id: chatId, first_name: 'اختبار', is_bot: false },
        text,
      },
    },
  };
}

function tgCallback(chatId: string, data: string) {
  return {
    channel: 'tg',
    update: {
      update_id: ++uid,
      callback_query: {
        id: `cb${++uid}`,
        from: { id: chatId, first_name: 'اختبار', is_bot: false },
        chat_instance: 'x',
        data,
        message: { message_id: 55, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' } },
      },
    },
  };
}

async function post(body: unknown) {
  const r = await fetch(`${BASE}/internal/simulate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${text}`);
  return JSON.parse(text);
}

async function main() {
  const customerA = '555000111';
  const customerB = '555000222';

  // اليوم المتاح الأول
  const day = bookingService.nextDays(14).find((d) => bookingService.daySlots(d.date).ok)!;
  const dayInfo = bookingService.daySlots(day.date);
  const slots = dayInfo.ok ? dayInfo.slots : [];
  const slot = slots[0]!;
  const hhmm = slot.replace(':', '');
  console.log('📅 اليوم المختار:', day.date, slot, '— الفتحات المتاحة:', slots.length);

  await post(tgMessage(customerA, '/start'));
  await post(tgCallback(customerA, 'm'));
  await post(tgCallback(customerA, 'c:subscriptions:0'));
  await post(tgCallback(customerA, 's:pro'));
  await post(tgCallback(customerA, 'b:pro'));
  await post(tgCallback(customerA, `d:pro:${day.date}`));
  await post(tgCallback(customerA, `t:pro:${day.date}:${hhmm}`));
  await post(tgCallback(customerA, 'wy'));

  const aBookings = listBookingsForContact(`tg:${customerA}`);
  console.log('✅ حجوزات A:', aBookings.map((b) => `${b.ref} ${b.slot_date} ${b.slot_time} ${b.status}`));
  if (aBookings.length !== 1) throw new Error('يجب أن يكون للعميل A حجز واحد');

  // الحجز المزدوج: عميل آخر يحجز نفس الفتلة بالضبط عبر القوائم
  await post(tgMessage(customerB, '/start'));
  await post(tgCallback(customerB, 'b:pro'));
  await post(tgCallback(customerB, `d:pro:${day.date}`));
  await post(tgCallback(customerB, `t:pro:${day.date}:${hhmm}`));
  const res = await post(tgCallback(customerB, 'wy'));
  const bBookings = listBookingsForContact(`tg:${customerB}`);
  console.log('🚫 حجوزات B بعد محاولة الازدواج:', bBookings.length, JSON.stringify(res));
  if (bBookings.length !== 0) throw new Error('يجب منع الحجز المزدوج لـ B');

  // لقطات إضافية: قائمة الحجوزات، تفاصيل، طلب خدمة رقمية، الدعم، عن مُريح
  await post(tgCallback(customerA, 'bk'));
  await post(tgCallback(customerA, `i:${aBookings[0]!.ref}`));
  await post(tgCallback(customerA, 'sp'));
  await post(tgCallback(customerA, 'ab'));
  await post(tgCallback(customerA, 'm'));
  await post(tgCallback(customerA, 'c:digital-services:0'));
  await post(tgCallback(customerA, 'o:website'));
  await post(tgCallback(customerA, 'oy'));

  // إلغاء الحجز
  await post(tgCallback(customerA, `x:${aBookings[0]!.ref}`));
  await post(tgCallback(customerA, `xy:${aBookings[0]!.ref}`));
  const after = listBookingsForContact(`tg:${customerA}`);
  console.log('حالة الحجز بعد الإلغاء:', after.map((b) => `${b.ref}:${b.status}`));
  if (after[0]!.status !== 'CANCELLED') throw new Error('يجب أن يكون الحجز CANCELLED');

  // محاولة العميل B الوصول لحجز A (ملكية)
  const trespass = await post(tgCallback(customerB, `i:${aBookings[0]!.ref}`));
  console.log('محاولة trespass:', JSON.stringify(trespass));

  // أداة غير مسجلة يجب أن تُرفض
  const { runTool } = await import('../src/agent/tools.js');
  const denied = await runTool('drop_database', {}, { sessionKey: `tg:${customerA}`, channel: 'tg' } as any);
  console.log('أداة غير مسجلة:', denied.ok, denied.userMessage ?? denied.data);
  if (denied.ok) throw new Error('يجب رفض الأداة غير المسجلة');

  console.log('occupancy النشطة الآن:', activeOccupancy().length, '(متوقع 0 بعد الإلغاء)');
  console.log('\n🎉 جميع فحوصات الدخان نجحت');
  void catalogService;
}

main().catch((e) => { console.error('💥', e); process.exit(1); });
