import { bookingService } from '../src/services/bookingService.js';

const BASE = process.env.BASE ?? 'http://localhost:3000';
let uid = 5_000_000;
const post = (b: unknown) => fetch(`${BASE}/internal/simulate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const msg = (id: number, text: string) => ({ channel: 'tg', update: { update_id: ++uid, message: { message_id: ++uid, date: Math.floor(Date.now() / 1000), chat: { id, type: 'private', first_name: ['أحمد', 'سارة', 'يوسف', 'مطعم الديار'][0] }, from: { id, first_name: 'عميل', is_bot: false }, text } } });
const cb = (id: number, data: string) => ({ channel: 'tg', update: { update_id: ++uid, callback_query: { id: `cb${++uid}`, from: { id, first_name: 'عميل', is_bot: false }, chat_instance: 'x', data, message: { message_id: 77, date: Math.floor(Date.now() / 1000), chat: { id, type: 'private' } } } } });

async function main() {
  const day = bookingService.nextDays(14).find((d) => d.slots.length > 0)!;
  const hhmm = day.slots[1]!.replace(':', '');

  // 1) عميل يحجز باقة pro ويترك الحجز مؤكدًا
  const a = 7000001;
  await post(msg(a, '/start'));
  await post(cb(a, 'b:pro'));
  await post(cb(a, `d:pro:${day.date}`));
  await post(cb(a, `t:pro:${day.date}:${hhmm}`));
  await post(cb(a, 'wy'));

  // 2) عميلة تطلب خدمة رقمية (موقع)
  const b = 7000002;
  await post(msg(b, '/start'));
  await post(cb(b, 'm'));
  await post(cb(b, 'c:digital-services:0'));
  await post(cb(b, 'o:website'));
  await post(cb(b, 'oy'));

  // 3) عميل يطلب التحدث مع موظف
  const c = 7000003;
  await post(msg(c, '/start'));
  await post(cb(c, 'sp'));
  await post(cb(c, 'sh'));

  // 4) محادثة نص حرة مع الذكاء (محرك وهمي في DEMO)
  const d = 7000004;
  await post(msg(d, 'مرحبا، بدي أعرف أسعار باقات المطاعم'));

  console.log('تم تعبئة المعاينة: حجز مؤكد + طلب خدمة + تحويل بشري + محادثة ذكاء');
}
main().catch((e) => { console.error(e); process.exit(1); });
