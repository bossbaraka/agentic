import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/db.js';
import { TelegramMenuRouter, type CallbackContext, type RouterDeps } from '../src/telegram/router.js';
import { bookingService } from '../src/services/bookingService.js';
import { listBookingsForContact } from '../src/db/repos/bookings.js';
import { userLanguage } from '../src/db/repos/users.js';
import { orderService } from '../src/services/orderService.js';

interface Screen { text: string; inline?: unknown }
const sent: Screen[] = [];
const edited: Screen[] = [];
const fakeDeps: RouterDeps = {
  async send(_chatId, opts) { sent.push(opts as Screen); return { ok: true, messageId: '1' }; },
  async edit(_chatId, _mid, opts) { edited.push(opts as Screen); return { ok: true }; },
};

function cb(chatId: string, data: string, messageId = 99): CallbackContext {
  return { id: `cb-${data}-${Math.random().toString(36).slice(2, 7)}`, fromId: chatId, chatId, messageId, data };
}

const DAYS = bookingService.nextDays(60).filter((d) => d.slots.length > 0);
function slot(dayIdx = 0) {
  const day = DAYS[dayIdx]!;
  return { date: day.date, time: day.slots[0]!, hhmm: day.slots[0]!.replace(':', '') };
}

describe('موجّه قوائم تيليجرام', () => {
  let router: TelegramMenuRouter;

  before(() => {
    router = new TelegramMenuRouter(fakeDeps);
  });
  beforeEach(() => {
    sent.length = 0;
    edited.length = 0;
  });

  it('/start يرسل لوحة المفاتيح الدائمة وشاشة الرئيسية', async () => {
    await router.start('100001', 'أحمد', '@ahmad', 'ar');
    assert.equal(sent.length, 1);
    assert.ok(sent[0]!.replyKeyboard);
    assert.match(sent[0]!.text, /مُريح/);
  });

  it('أمر نصي /services يُعالَج بالقوائم ولا يمر للذكاء', async () => {
    const handled = await router.handleText({ channel: 'tg', from: 'tg:100001', body: '/menu' } as any);
    assert.equal(handled, true);
    assert.ok(sent.some((s) => Array.isArray(s.inline)));
  });

  it('النص الحر لا يعترضه الموجّه (يمر للمنسّق الذكي)', async () => {
    const handled = await router.handleText({ channel: 'tg', from: 'tg:100001', body: 'بدي أسألك عن الباقات' } as any);
    assert.equal(handled, false);
  });

  it('مسار حجز كامل عبر الأزرار: فئة ← خدمة ← تاريخ ← وقت ← تأكيد', async () => {
    const chat = '100002';
    const { date, hhmm } = slot(0);
    assert.equal(await router.handleCallback(cb(chat, 'm'))?.unhandled ?? true, true); // m يعالج: null
    await router.handleCallback(cb(chat, 'c:subscriptions:0'));
    await router.handleCallback(cb(chat, 's:pro'));
    await router.handleCallback(cb(chat, 'b:pro'));
    await router.handleCallback(cb(chat, `d:pro:${date}`));
    await router.handleCallback(cb(chat, `t:pro:${date}:${hhmm}`));
    const confirm = edited.at(-1)!;
    assert.match(confirm.text, /راجع بيانات الحجز|Review/);
    const wy = await router.handleCallback(cb(chat, 'wy'));
    assert.equal(wy, null);
    assert.match(edited.at(-1)!.text, /BKG-/);

    const rows = listBookingsForContact(`tg:${chat}`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.slot_date, date);
  });

  it('محاولة الحجز المزدوج تعيد تنبيهًا منبثقًا بلا استثناء', async () => {
    const chatA = '100003';
    const chatB = '100004';
    const { date, hhmm } = slot(1);
    for (const chat of [chatA, chatB]) {
      await router.handleCallback(cb(chat, 'b:pro'));
      await router.handleCallback(cb(chat, `d:pro:${date}`));
      await router.handleCallback(cb(chat, `t:pro:${date}:${hhmm}`));
    }
    await router.handleCallback(cb(chatA, 'wy'));
    const result = await router.handleCallback(cb(chatB, 'wy'));
    assert.ok(result?.popup);
    assert.match(result!.alert ?? '', /محجوز|متاحة|مكتمل/);
    assert.equal(listBookingsForContact(`tg:${chatB}`).length, 0);
  });

  it('حماية الملكية: عميل لا يرى تفاصيل حجز غيره', async () => {
    const { date, hhmm } = slot(2);
    const owner = '100005';
    await router.handleCallback(cb(owner, 'b:pro'));
    await router.handleCallback(cb(owner, `d:pro:${date}`));
    await router.handleCallback(cb(owner, `t:pro:${date}:${hhmm}`));
    await router.handleCallback(cb(owner, 'wy'));
    const ref = listBookingsForContact(`tg:${owner}`)[0]!.ref;
    const r = await router.handleCallback(cb('100006', `i:${ref}`));
    assert.ok(r?.popup);
  });

  it('زر تبديل اللغة يبدّل لغة المستخدم ولوحة المفاتيح', async () => {
    const chat = '100007';
    await router.handleCallback(cb(chat, 'lg:en'));
    assert.equal(userLanguage(`tg:${chat}`), 'en');
    assert.ok(sent.at(-1)!.replyKeyboard);
  });

  it('زر غير معروف للقوائم يُعلَّم unhandled ليمر للذكاء', async () => {
    const r = await router.handleCallback(cb('100008', 'qr:something'));
    assert.equal(r?.unhandled, true);
  });

  it('/start مع مرجع طلب (deep link) يعرض تفاصيل الطلب المؤكد مباشرة', async () => {
    const order = orderService.launchOrder({
      contactKey: 'tg:999001',
      summary: 'طلب باقة احترافية تجريبي',
      payload: { restaurant_name: 'مطعم البركة' },
    });
    const handled = await router.handleText({
      channel: 'tg',
      from: 'tg:999001',
      body: `/start ${order.ref}`,
    } as any);
    assert.equal(handled, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.text, new RegExp(order.ref));
    assert.match(sent[0]!.text, /تفاصيل طلبك المؤكد/);
  });
});
