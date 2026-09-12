/**
 * موجّه واجهة تيليجرام — قوائم Inline/Reply، ترقيم صفحات، معالجات حجز/طلب،
 * وحوارات تأكيد. كل عملية حسّاسة تمر عبر طبقة الخدمات (لا منطق أعمال هنا).
 *
 * معزول عن الإرسال الفعلي عبر واجهة RouterDeps قابلة للحقن — هذا يجعل مسارات
 * القوائم قابلة للاختبار بدون شبكة.
 */
import { catalogService, type ServiceView } from '../services/catalogService.js';
import { bookingService } from '../services/bookingService.js';
import { orderService } from '../services/orderService.js';
import { handoffService } from '../services/handoffService.js';
import { ServiceError } from '../services/errors.js';
import { t, type UiLang } from '../lib/i18n.js';
import { store } from '../lib/store.js';
import { MUREEH_PLANS } from '../agent/plans.js';
import { upsertUser, userLanguage, setUserLanguage } from '../db/repos/users.js';
import { getService } from '../db/repos/catalog.js';
import type { NormalizedInbound } from '../whatsapp/types.js';
import {
  tgSendMessage,
  tgEditMessage,
  type SendMessageOpts,
  type TgInlineKeyboard,
} from './client.js';
import {
  aboutInline,
  backHomeInline,
  bookingDetailInline,
  bookingsListInline,
  categoriesInline,
  confirmInline,
  datePickerInline,
  homeInline,
  mainReplyKeyboard,
  ordersListInline,
  serviceInline,
  servicesInline,
  supportInline,
  timePickerInline,
} from './keyboards.js';
import { menus, dayName, type WizardState } from './menus.js';
import { adminService } from '../services/adminService.js';

export interface RouterDeps {
  send(chatId: string, opts: SendMessageOpts): Promise<{ ok: boolean; messageId?: string; error?: string }>;
  edit(chatId: string, messageId: string | number, opts: { text: string; inline?: TgInlineKeyboard }): Promise<{ ok: boolean; error?: string }>;
}

export interface CallbackContext {
  id: string;
  fromId: string;
  chatId: string;
  messageId: string | number;
  data: string;
}

export interface CallbackResult {
  alert?: string;
  popup?: boolean;
  /** ليس زرًا من قوائم النظام (مثل أزرار الردود السريعة للذكاء) — يُمرَّر للمنسّق */
  unhandled?: boolean;
}

const defaultDeps: RouterDeps = {
  send: (chatId, opts) => tgSendMessage(chatId, opts),
  edit: (chatId, messageId, opts) => tgEditMessage(chatId, messageId, opts),
};

const PAGE_SIZE = 6;
const DATE_PAGE_SIZE = 9;

export class TelegramMenuRouter {
  private wizards = new Map<string, WizardState>();
  constructor(private deps: RouterDeps = defaultDeps) {}

  private lang(contactKey: string): UiLang {
    const l = userLanguage(contactKey);
    return l === 'en' ? 'en' : 'ar';
  }

  private key(chatId: string): string {
    return `tg:${chatId}`;
  }

  private isAdmin(telegramId: string): boolean {
    try {
      return Boolean(adminService.resolveByTelegramId(telegramId));
    } catch {
      return false;
    }
  }

  // ───────────────────────── نقاط الدخول ─────────────────────────

  /** شاشة /start — يضبط لوحة المفاتيح الدائمة، ويدعم الربط العميق (Deep Linking) بالطلبات أو الباقات */
  async start(chatId: string, name?: string, username?: string, lang?: UiLang, payload?: string): Promise<void> {
    const key = this.key(chatId);
    const detected = lang ?? this.lang(key);
    upsertUser(key, {
      displayName: name ?? null,
      username: username ?? null,
      language: detected,
    });

    if (payload && payload.trim()) {
      const cleanRef = payload.trim();
      // 1) إذا كان مرجع طلب مؤكد (ORD- أو SUB-)
      if (/^(ORD|SUB)-/i.test(cleanRef)) {
        try {
          const order = orderService.byRef(cleanRef);
          if (order) {
            await this.deps.send(chatId, {
              text:
                `📦 *تفاصيل طلبك المؤكد — ${order.ref}* ✅\n\n` +
                menus.orderDetail(order, detected) +
                `\n\nملفك وصل إدارة المنصة وجاري تجهيز نسختك في أقرب وقت 🚀`,
              inline: backHomeInline(detected),
              replyKeyboard: mainReplyKeyboard(detected),
            });
            return;
          }
        } catch {
          // لم يتم العثور على الطلب — استمر للشاشة العادية
        }
      }

      // 2) إذا كان اسم أو معرف باقة
      const cleanLower = cleanRef.toLowerCase();
      const matchedPlan = MUREEH_PLANS.find(
        (p) => p.id === cleanLower || p.name.includes(cleanRef) || cleanRef.includes(p.name),
      );
      if (matchedPlan) {
        store.patchProfile(key, { preferred_plan: matchedPlan.id });
        await this.deps.send(chatId, {
          text:
            `👋 أهلاً بك! اخترت باقة *${matchedPlan.name}* (${matchedPlan.priceMonthly} ₪/شهرياً) 🚀\n\n` +
            `${matchedPlan.tagline}\n\n` +
            `دعنا نجهز لك نسختك الآن، اكتب لي اسم مطعمك لنبدأ فوراً! 👇`,
          inline: homeInline(detected, this.isAdmin(chatId)),
          replyKeyboard: mainReplyKeyboard(detected),
        });
        return;
      }
    }

    const firstName = (name ?? '').trim().split(/\s+/)[0];
    await this.deps.send(chatId, {
      text: menus.home(detected, firstName),
      inline: homeInline(detected, this.isAdmin(chatId)),
      replyKeyboard: mainReplyKeyboard(detected),
    });
  }

  /**
   * رسالة نصية/أمر من المستخدم.
   * يرجع true إذا عالجها الموجّه (لا تمر للـ AI).
   */
  async handleText(msg: NormalizedInbound): Promise<boolean> {
    if (msg.channel !== 'tg') return false;
    const chatId = msg.from.replace(/^tg:/, '');
    const key = msg.from;
    const text = (msg.body ?? '').trim();
    if (!text) return false;
    const lang = this.lang(key);

    const lower = text.toLowerCase().replace(/^\//, '');
    const labels = new Set([
      'start', 'menu', 'home', 'services', 'bookings', 'orders', 'support', 'about',
      t('ar', 'menu.home'), t('ar', 'menu.services'), t('ar', 'menu.orders'), t('ar', 'menu.bookings'), t('ar', 'menu.support'), t('ar', 'menu.about'),
      t('en', 'menu.home'), t('en', 'menu.services'), t('en', 'menu.orders'), t('en', 'menu.bookings'), t('en', 'menu.support'), t('en', 'menu.about'),
    ]);

    const isCommand = text.startsWith('/');
    const command = isCommand ? lower.split(/[@\s]/)[0]! : '';
    const isLabel = labels.has(text) || labels.has(command);

    if (!isCommand && !isLabel) return false;
    if (['start', 'home'].includes(command) || text === t(lang, 'menu.home')) {
      const parts = text.split(/\s+/);
      const payload = parts.length > 1 ? parts.slice(1).join(' ').trim() : undefined;
      await this.start(chatId, msg.contactName, msg.telegramUsername, undefined, payload);
      return true;
    }
    if (command === 'menu' || command === 'services' || text === t(lang, 'menu.services')) {
      await this.sendScreen(chatId, this.screenServices(lang));
      return true;
    }
    if (command === 'bookings' || text === t(lang, 'menu.bookings')) {
      await this.sendScreen(chatId, this.screenBookings(key, lang));
      return true;
    }
    if (command === 'orders' || text === t(lang, 'menu.orders')) {
      await this.sendScreen(chatId, this.screenOrders(key, lang));
      return true;
    }
    if (command === 'support' || text === t(lang, 'menu.support')) {
      await this.sendScreen(chatId, { text: menus.support(lang), inline: supportInline(lang) });
      return true;
    }
    if (command === 'about' || text === t(lang, 'menu.about')) {
      await this.sendScreen(chatId, { text: menus.about(lang), inline: aboutInline(lang) });
      return true;
    }
    if (command === 'start') {
      await this.start(chatId, msg.contactName, msg.telegramUsername);
      return true;
    }
    return false;
  }

  /** معالجة ضغطة زر — يرجع تنبيهًا اختياريًا يظهر للمستخدم */
  async handleCallback(c: CallbackContext): Promise<CallbackResult | null> {
    const key = this.key(c.chatId);
    const lang = this.lang(key);
    try {
      const parts = c.data.split(':');
      const head = parts[0]!;
      const arg = parts[1] ?? '';
      const arg2 = parts[2] ?? '';
      const arg3 = parts[3] ?? '';

      // الإدارة لها موجّهها الخاص
      if (head === 'a') return { unhandled: true };

      switch (head) {
        case 'h':
          await this.edit(c, { text: menus.home(lang), inline: homeInline(lang, this.isAdmin(c.fromId)) });
          return null;
        case 'lg': {
          const next = (arg === 'en' ? 'en' : 'ar') as UiLang;
          setUserLanguage(key, next);
          await this.deps.send(c.chatId, {
            text: next === 'en' ? 'Switched to English ✅' : t('ar', 'lang.changed'),
            inline: homeInline(next, this.isAdmin(c.fromId)),
            replyKeyboard: mainReplyKeyboard(next),
          });
          return null;
        }
        case 'm':
          await this.edit(c, this.screenServices(lang));
          return null;
        case 'c':
          return await this.openCategory(c, arg, arg2 ? Number(arg2) : 0, lang);
        case 's':
          return await this.openService(c, arg, lang);
        case 'b':
          return await this.beginBooking(c, arg, lang);
        case 'dp':
          return await this.openDatePage(c, arg, arg2 ? Number(arg2) : 0, lang);
        case 'd':
          return await this.openSlots(c, arg, arg2, lang);
        case 't':
          return await this.confirmSlot(c, arg, arg2, arg3, lang);
        case 'o':
          return await this.beginOrder(c, arg, lang);
        case 'oy':
          return await this.finishOrder(c, lang);
        case 'on':
          this.wizards.delete(key);
          await this.edit(c, { text: menus.home(lang), inline: homeInline(lang, this.isAdmin(c.fromId)) });
          return null;
        case 'wy':
          return await this.finishWizard(c, lang);
        case 'wn':
          this.wizards.delete(key);
          await this.edit(c, this.screenBookings(key, lang));
          return null;
        case 'bk':
          await this.edit(c, this.screenBookings(key, lang));
          return null;
        case 'i':
          return await this.openBooking(c, arg, lang);
        case 'r':
          return await this.beginReschedule(c, arg, lang);
        case 'x': {
          await this.edit(c, {
            text: `${t(lang, 'booking.cancel_confirm_q')}\n\n${arg}`,
            inline: confirmInline(`xy:${arg}`, `xn:${arg}`, t(lang, 'booking.yes_cancel'), t(lang, 'booking.keep')),
          });
          return null;
        }
        case 'xy':
          return await this.confirmCancel(c, arg, lang);
        case 'xn':
          return await this.openBooking(c, arg, lang);
        case 'odl':
          await this.edit(c, this.screenOrders(key, lang));
          return null;
        case 'od':
          return await this.openOrder(c, arg, lang);
        case 'sp':
          await this.edit(c, { text: menus.support(lang), inline: supportInline(lang) });
          return null;
        case 'sh':
          return await this.requestHuman(c, lang);
        case 'ab':
          await this.edit(c, { text: menus.about(lang), inline: aboutInline(lang) });
          return null;
        default:
          // زر غير معروف للقوائم (أزرار الذكاء qr:... إلخ) — مرّره للمنسّق
          return { unhandled: true };
      }
    } catch (err) {
      return { alert: err instanceof ServiceError ? err.message : t(lang, 'common.error'), popup: true };
    }
  }

  // ───────────────────────── الشاشات ─────────────────────────

  private async sendScreen(chatId: string, screen: { text: string; inline: TgInlineKeyboard }): Promise<void> {
    await this.deps.send(chatId, screen);
  }

  private async edit(c: CallbackContext, screen: { text: string; inline?: TgInlineKeyboard }): Promise<void> {
    await this.deps.edit(c.chatId, c.messageId, { text: screen.text, inline: screen.inline });
  }

  private screenServices(lang: UiLang) {
    const groups = catalogService.byCategory(lang);
    return { text: menus.servicesRoot(lang), inline: categoriesInline(groups, lang) };
  }

  private async openCategory(c: CallbackContext, slug: string, page: number, lang: UiLang): Promise<CallbackResult | null> {
    const group = slug === 'all'
      ? { category: { slug: 'all', name_ar: 'كل الخدمات', name_en: 'All services' }, services: catalogService.paginated(0, 100, lang).items }
      : catalogService.byCategorySlug(slug, lang);
    if (!group) return { alert: t(lang, 'common.no_results') };
    const pages = Math.max(1, Math.ceil(group.services.length / PAGE_SIZE));
    const safePage = Math.min(Math.max(0, page), pages - 1);
    const items = group.services.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
    const title = lang === 'en' && group.category.name_en ? group.category.name_en : group.category.name_ar;
    await this.edit(c, {
      text: menus.category(title, lang, safePage, pages),
      inline: servicesInline(items, slug, safePage, pages, lang),
    });
    return null;
  }

  private async openService(c: CallbackContext, slug: string, lang: UiLang): Promise<CallbackResult | null> {
    const view = catalogService.details(slug, lang);
    if (!view) return { alert: t(lang, 'common.no_results') };
    await this.edit(c, {
      text: menus.service(view, lang),
      inline: serviceInline(view.slug, view.categorySlug, view.isBookable, lang),
    });
    return null;
  }

  private dateScreen(slug: string, page: number, lang: UiLang): { text: string; inline: TgInlineKeyboard } | { alert: string } {
    const view = catalogService.details(slug, lang);
    if (!view) return { alert: t(lang, 'common.no_results') };
    const days = bookingService.nextDays(DATE_PAGE_SIZE * 2);
    if (!days.length) return { alert: t(lang, 'common.no_results') };
    const chunk = days.slice(page * DATE_PAGE_SIZE, page * DATE_PAGE_SIZE + DATE_PAGE_SIZE);
    return {
      text: menus.datePicker(view, lang),
      inline: datePickerInline(slug, chunk, page, lang),
    };
  }

  private async beginBooking(c: CallbackContext, slug: string, lang: UiLang): Promise<CallbackResult | null> {
    const view = catalogService.details(slug, lang);
    if (!view || !view.isBookable) return { alert: t(lang, 'services.unavailable') };
    this.wizards.set(this.key(c.chatId), { mode: 'booking', slug });
    const screen = this.dateScreen(slug, 0, lang);
    if ('alert' in screen) return { alert: screen.alert };
    await this.edit(c, screen);
    return null;
  }

  private async openDatePage(c: CallbackContext, slug: string, page: number, lang: UiLang): Promise<CallbackResult | null> {
    const screen = this.dateScreen(slug, page, lang);
    if ('alert' in screen) return { alert: screen.alert };
    await this.edit(c, screen);
    return null;
  }

  private async openSlots(c: CallbackContext, slug: string, date: string, lang: UiLang): Promise<CallbackResult | null> {
    const view = catalogService.details(slug, lang);
    if (!view) return { alert: t(lang, 'common.no_results') };
    const w = this.wizards.get(this.key(c.chatId));
    if (w) { w.date = date; this.wizards.set(this.key(c.chatId), w); }
    const day = bookingService.daySlots(date);
    if (!day.ok) return { alert: day.reason, popup: true };
    await this.edit(c, { text: menus.slots(view, date, lang), inline: timePickerInline(slug, date, day.slots, lang) });
    return null;
  }

  private async confirmSlot(c: CallbackContext, slug: string, date: string, hhmm: string, lang: UiLang): Promise<CallbackResult | null> {
    const time = `${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}`;
    const w = this.wizards.get(this.key(c.chatId)) ?? { mode: 'booking' as const, slug };
    w.slug = slug; w.date = date; w.time = time;
    this.wizards.set(this.key(c.chatId), w);
    const view = catalogService.details(slug, lang);
    if (!view) return { alert: t(lang, 'common.no_results') };
    await this.edit(c, {
      text: menus.bookingConfirm(w, view.name, lang),
      inline: confirmInline('wy', 'wn', t(lang, 'booking.confirm_btn'), t(lang, 'booking.cancel_btn')),
    });
    return null;
  }

  private async finishWizard(c: CallbackContext, lang: UiLang): Promise<CallbackResult | null> {
    const key = this.key(c.chatId);
    const w = this.wizards.get(key);
    if (!w || !w.date || !w.time) return { alert: t(lang, 'common.error'), popup: true };

    try {
      if (w.mode === 'move' && w.ref) {
        const updated = bookingService.reschedule({
          contactKey: key, ref: w.ref, date: w.date, time: w.time, serviceRef: w.slug,
        });
        this.wizards.delete(key);
        const label = this.serviceLabelOf(updated.service_id, updated.plan_slug, lang);
        await this.edit(c, {
          text: menus.bookingConfirmed(updated, label, lang),
          inline: bookingDetailInline(updated.ref, true, lang),
        });
        return null;
      }

      const { booking, service } = bookingService.create({
        contactKey: key,
        serviceRef: w.slug,
        date: w.date,
        time: w.time,
        fullName: store.get(key).profile?.full_name ?? store.get(key).name,
        language: lang,
        idempotencyKey: `menu:${key}:${w.slug}:${w.date}:${w.time}`,
      });
      this.wizards.delete(key);
      const label = service
        ? (lang === 'en' && service.name_en ? service.name_en : service.name_ar)
        : this.serviceLabelOf(booking.service_id, booking.plan_slug, lang);
      await this.edit(c, {
        text: menus.bookingConfirmed(booking, label, lang),
        inline: bookingDetailInline(booking.ref, true, lang),
      });
      return null;
    } catch (err) {
      this.wizards.set(key, w);
      if (err instanceof ServiceError) {
        // عُد لشاشة الأوقات ليختار الفتحة المتاحة
        const day = bookingService.daySlots(w.date);
        const view = catalogService.details(w.slug, lang);
        if (view && day.ok) {
          await this.edit(c, { text: menus.slots(view, w.date, lang), inline: timePickerInline(w.slug, w.date, day.slots, lang) });
        }
        return { alert: err.message, popup: true };
      }
      return { alert: t(lang, 'common.error'), popup: true };
    }
  }

  // ───────────────────────── مسار طلب الخدمة (غير المحجوزة بموعد) ─────────────────────────

  private async beginOrder(c: CallbackContext, slug: string, lang: UiLang): Promise<CallbackResult | null> {
    const view = catalogService.details(slug, lang);
    if (!view) return { alert: t(lang, 'common.no_results') };
    if (view.isBookable) {
      return this.beginBooking(c, slug, lang);
    }
    this.wizards.set(this.key(c.chatId), { mode: 'order', slug });
    await this.edit(c, {
      text: menus.orderConfirm(view.name, lang),
      inline: confirmInline('oy', 'on', t(lang, 'order.confirm_btn'), t(lang, 'booking.cancel_btn')),
    });
    return null;
  }

  private async finishOrder(c: CallbackContext, lang: UiLang): Promise<CallbackResult | null> {
    const key = this.key(c.chatId);
    const w = this.wizards.get(key);
    if (!w) return { alert: t(lang, 'common.error'), popup: true };
    try {
      const order = orderService.requestService({ contactKey: key, serviceIdOrSlug: w.slug, language: lang });
      this.wizards.delete(key);
      await this.edit(c, {
        text: `${t(lang, 'order.created')} *${order.ref}* ✅\n${t(lang, 'order.note')}`,
        inline: backHomeInline(lang),
      });
      return null;
    } catch (err) {
      this.wizards.delete(key);
      return { alert: err instanceof ServiceError ? err.message : t(lang, 'common.error'), popup: true };
    }
  }

  // ───────────────────────── حجوزاتي ─────────────────────────

  private screenBookings(key: string, lang: UiLang) {
    const rows = bookingService.listFor(key);
    const active = rows.filter((b) => b.status === 'PENDING' || b.status === 'CONFIRMED');
    return { text: menus.bookingsList(rows, lang), inline: bookingsListInline(active, lang) };
  }

  private async openBooking(c: CallbackContext, ref: string, lang: UiLang): Promise<CallbackResult | null> {
    const key = this.key(c.chatId);
    const booking = bookingService.byRef(ref);
    if (!booking) return { alert: t(lang, 'common.no_results') };
    if (booking.contact_key !== key) {
      return { alert: t(lang, 'common.not_owner'), popup: true };
    }
    await this.edit(c, {
      text: menus.bookingDetail(booking, lang),
      inline: bookingDetailInline(booking.ref, ['PENDING', 'CONFIRMED'].includes(booking.status), lang),
    });
    return null;
  }

  private async beginReschedule(c: CallbackContext, ref: string, lang: UiLang): Promise<CallbackResult | null> {
    const key = this.key(c.chatId);
    // الملكية + النشاط يُفرضان في requireOwnedBooking عند التنفيذ؛ فحص مبدئي هنا لتجربة سلسة
    const booking = bookingService.byRef(ref);
    if (!booking) return { alert: t(lang, 'common.no_results') };
    if (booking.contact_key !== key) return { alert: t(lang, 'common.not_owner'), popup: true };
    const svc = booking.service_id ? getService(booking.service_id) : undefined;
    const slug = svc?.slug ?? booking.plan_slug ?? 'pro';
    this.wizards.set(key, { mode: 'move', slug, ref });
    const screen = this.dateScreen(slug, 0, lang);
    if ('alert' in screen) return { alert: screen.alert };
    await this.edit(c, screen);
    return null;
  }

  private async confirmCancel(c: CallbackContext, ref: string, lang: UiLang): Promise<CallbackResult | null> {
    const key = this.key(c.chatId);
    try {
      const cancelled = bookingService.cancel({ contactKey: key, ref });
      await this.edit(c, {
        text: `${t(lang, 'booking.cancelled')} ✅\n${cancelled.ref} — ${cancelled.slot_date} ${cancelled.slot_time}`,
        inline: backHomeInline(lang),
      });
      return null;
    } catch (err) {
      return { alert: err instanceof ServiceError ? err.message : t(lang, 'common.error'), popup: true };
    }
  }

  // ───────────────────────── طلباتي ─────────────────────────

  private screenOrders(key: string, lang: UiLang) {
    const rows = orderService.listFor(key);
    return { text: menus.ordersList(rows, lang), inline: ordersListInline(rows, lang) };
  }

  private async openOrder(c: CallbackContext, ref: string, lang: UiLang): Promise<CallbackResult | null> {
    try {
      const order = orderService.byRef(ref, this.key(c.chatId));
      await this.edit(c, { text: menus.orderDetail(order, lang), inline: backHomeInline(lang) });
      return null;
    } catch (err) {
      return { alert: err instanceof ServiceError ? err.message : t(lang, 'common.error'), popup: true };
    }
  }

  // ───────────────────────── الدعم والتحويل ─────────────────────────

  private async requestHuman(c: CallbackContext, lang: UiLang): Promise<CallbackResult | null> {
    const key = this.key(c.chatId);
    const session = store.get(key);
    handoffService.request({
      contactKey: key,
      name: session.name,
      reason: 'طلب العميل التحدث مع موظف (زر الدعم)',
      lastMessage: session.messages.filter((m) => m.dir === 'in').slice(-1)[0]?.body ?? '',
    });
    store.setState(key, 'human', '🙋 تحويل عبر زر الدعم');
    store.recordHandoff(key);
    await this.edit(c, { text: t(lang, 'support.handoff_sent'), inline: backHomeInline(lang) });
    return null;
  }

  private serviceLabelOf(serviceId: number | null, planSlug: string | null, lang: UiLang): string {
    const view = serviceId ? catalogService.details(serviceId, lang) : planSlug ? catalogService.details(planSlug, lang) : undefined;
    return view?.name ?? (lang === 'en' ? 'Activation appointment' : planSlug ?? 'موعد تفعيل');
  }
}

export const menuRouter = new TelegramMenuRouter();
export { dayName };
