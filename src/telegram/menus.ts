/** توليد نصوص شاشات القوائم — ثنائية اللغة، البيانات من الخدمات/قاعدة البيانات فقط */
import { t, bookingStatusText, orderStatusText, type UiLang } from '../lib/i18n.js';
import { catalogService, type ServiceView } from '../services/catalogService.js';
import { DAY_NAMES, DAY_NAMES_EN, bookingStatusIcon } from '../agent/bookings.js';
import { formatAvailabilityText } from '../agent/bookings.js';
import { planName } from '../agent/bookings.js';
import type { BookingRow, OrderRow } from '../db/types.js';

export interface WizardState {
  mode: 'booking' | 'order' | 'move';
  slug: string;
  date?: string;
  time?: string;
  /** حجز يُعاد جدولته (move) */
  ref?: string;
}

export function dayName(date: string, lang: UiLang): string {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return lang === 'en' ? DAY_NAMES_EN[d]! : DAY_NAMES[d]!;
}

export function serviceLabel(booking: Pick<BookingRow, 'service_id' | 'plan_slug'>, lang: UiLang): string {
  const key = booking.service_id ?? booking.plan_slug ?? '';
  if (key !== '') {
    const view = catalogService.details(key as any, lang);
    if (view) return view.name;
  }
  return lang === 'en' ? 'Activation appointment' : planName(booking.plan_slug);
}

function priceLine(view: ServiceView, lang: UiLang): string {
  if (view.price === null || view.price === undefined) {
    return lang === 'en' ? '💵 Price: On request' : '💵 السعر: حسب الطلب';
  }
  const suffix =
    view.billingPeriod === 'monthly' ? (lang === 'en' ? '/month' : ' شهريًا')
    : view.billingPeriod === 'yearly' ? (lang === 'en' ? '/year' : ' سنويًا')
    : view.billingPeriod === 'hourly' ? (lang === 'en' ? '/hour' : ' للساعة')
    : '';
  const meta = view.meta;
  if (view.slug === 'starter' || view.slug === 'pro' || view.slug === 'enterprise') {
    const yearly = typeof meta.priceYearly === 'number' && meta.priceYearly > 0
      ? (lang === 'en' ? `\n📆 Yearly: ${meta.priceYearly} ILS (≈${meta.priceYearlyPerMonth}/month)` : `\n📆 سنوي: ${meta.priceYearly} ₪ (≈${meta.priceYearlyPerMonth} ₪/شهر)`)
      : '';
    return (lang === 'en' ? `💵 Price: *${view.price} ILS${suffix}*` : `💵 السعر: *${view.price} ₪${suffix}*`) + yearly;
  }
  return lang === 'en' ? `💵 Price: *${view.price} ILS${suffix}*` : `💵 السعر: *${view.price} ₪${suffix}*`;
}

export const menus = {
  home(lang: UiLang, name?: string): string {
    const hi = name ? (lang === 'en' ? `Hi ${name} 👋\n` : `أهلًا ${name} 👋\n`) : '';
    return `${hi}${t(lang, 'home.title')}\n${t(lang, 'home.subtitle')}`;
  },

  servicesRoot(lang: UiLang): string {
    return t(lang, 'services.title');
  },

  category(title: string, lang: UiLang, page: number, pages: number): string {
    const pg = pages > 1 ? `\n${t(lang, 'services.page')} ${page + 1}/${pages}` : '';
    return `🛎️ *${title}*${pg}`;
  },

  service(view: ServiceView, lang: UiLang): string {
    const lines = [`*${view.name}*`, '', view.description, '', priceLine(view, lang)];
    if (view.durationText) {
      lines.push(lang === 'en' ? `⏱️ ${t(lang, 'services.duration')}: ${view.durationText}` : `⏱️ ${t(lang, 'services.duration')}: ${view.durationText}`);
    }
    if (view.availabilityText) lines.push(`📅 ${view.availabilityText}`);
    if (view.features.length) {
      lines.push('', lang === 'en' ? '✨ Features:' : '✨ المزايا:');
      for (const f of view.features.slice(0, 8)) lines.push(`• ${f}`);
    }
    return lines.join('\n');
  },

  datePicker(view: ServiceView, lang: UiLang): string {
    return `*${view.name}*\n\n🗓️ ${t(lang, 'booking.choose_date')}`;
  },

  slots(view: ServiceView, date: string, lang: UiLang): string {
    return `*${view.name}*\n\n⏰ ${t(lang, 'booking.choose_time')} *${date}* (${dayName(date, lang)})`;
  },

  bookingConfirm(w: WizardState, viewName: string, lang: UiLang): string {
    const lines = [
      t(lang, 'booking.confirm_title'),
      '',
      `${lang === 'en' ? '🏷️ Service' : '🏷️ الخدمة'}: ${viewName}`,
      `📅 ${t(lang, 'booking.date')}: ${w.date} (${w.date ? dayName(w.date, lang) : ''})`,
      `⏰ ${t(lang, 'booking.time')}: ${w.time}`,
      '',
    ];
    return lines.join('\n');
  },

  orderConfirm(viewName: string, lang: UiLang): string {
    return `${t(lang, 'order.confirm_q')}\n\n🏷️ ${viewName}`;
  },

  bookingConfirmed(booking: BookingRow, label: string, lang: UiLang): string {
    return [
      t(lang, 'booking.confirmed_title'),
      `${t(lang, 'booking.ref')}: *${booking.ref}*`,
      `📅 ${booking.slot_date} (${dayName(booking.slot_date, lang)}) · ${booking.slot_time}`,
      `📦 ${label}`,
      '',
      t(lang, 'booking.reminder_note'),
    ].join('\n');
  },

  bookingFailed(reason: string, lang: UiLang): string {
    return `⚠️ ${t(lang, 'booking.failed_title')}: ${reason}`;
  },

  bookingsList(rows: BookingRow[], lang: UiLang): string {
    if (!rows.length) return t(lang, 'booking.none');
    const active = rows.filter((b) => b.status === 'PENDING' || b.status === 'CONFIRMED');
    const past = rows.filter((b) => !['PENDING', 'CONFIRMED'].includes(b.status));
    const lines = [t(lang, 'booking.list_title')];
    if (active.length) {
      lines.push('');
      for (const b of active.slice(0, 8)) {
        lines.push(`${bookingStatusIcon(b.status)} ${b.ref} — ${b.slot_date} ${b.slot_time} · ${serviceLabel(b, lang)}`);
      }
    }
    if (past.length) {
      lines.push('', lang === 'en' ? 'Past:' : 'السابقة:');
      for (const b of past.slice(0, 5)) {
        lines.push(`${bookingStatusIcon(b.status)} ${b.ref} — ${b.slot_date} (${bookingStatusText(b.status, lang)})`);
      }
    }
    return lines.join('\n');
  },

  bookingDetail(b: BookingRow, lang: UiLang): string {
    const canManage = b.status === 'PENDING' || b.status === 'CONFIRMED';
    const lines = [
      `*${b.ref}* — ${bookingStatusIcon(b.status)} ${bookingStatusText(b.status, lang)}`,
      `📦 ${serviceLabel(b, lang)}`,
      `📅 ${b.slot_date} (${dayName(b.slot_date, lang)}) · ${b.slot_time}`,
    ];
    if (b.full_name) lines.push(`👤 ${b.full_name}`);
    if (b.notes) lines.push(`📝 ${b.notes}`);
    if (b.cancellation_reason) lines.push(lang === 'en' ? `Cancellation: ${b.cancellation_reason}` : `سبب الإلغاء: ${b.cancellation_reason}`);
    if (!canManage) lines.push('', lang === 'en' ? 'This booking is closed.' : 'هذا الحجز مغلق.');
    return lines.join('\n');
  },

  ordersList(rows: OrderRow[], lang: UiLang): string {
    if (!rows.length) return t(lang, 'order.none');
    const lines = [t(lang, 'order.list_title'), ''];
    for (const o of rows.slice(0, 10)) {
      lines.push(`• ${o.ref} — ${orderStatusText(o.status, lang)} — ${o.summary.slice(0, 60)}`);
    }
    return lines.join('\n');
  },

  orderDetail(o: OrderRow, lang: UiLang): string {
    return [
      `*${o.ref}* — ${orderStatusText(o.status, lang)}`,
      `📅 ${new Date(o.created_at).toLocaleString(lang === 'en' ? 'en-GB' : 'ar-PS', { timeZone: 'Asia/Jerusalem' })}`,
      o.service_id ? `📦 ${serviceLabel({ service_id: o.service_id, plan_slug: null }, lang)}` : '',
      '',
      o.summary,
    ].filter(Boolean).join('\n');
  },

  support(lang: UiLang): string {
    return `${t(lang, 'support.title')}\n${t(lang, 'support.body')}`;
  },

  about(lang: UiLang): string {
    if (lang === 'en') {
      return [
        t(lang, 'about.title'),
        '',
        'MUREEH is a cloud platform for restaurants and cafés (QR menu, live kitchen display, POS, analytics), plus a digital-services studio: websites, AI agents, WhatsApp automation, booking systems and custom solutions.',
        '',
        `⏰ Activation-team hours: ${formatAvailabilityText('en')}`,
        '💬 Sales & support: +972 59 891 559 (Telegram / WhatsApp)',
        '🤖 I answer 24/7; human follow-up is during working hours.',
      ].join('\n');
    }
    return [
      t(lang, 'about.title'),
      '',
      'منصة *مُريح* نظام سحابي متكامل للمطاعم والمقاهي (منيو QR، شاشة مطبخ حية، كاشير POS، تحليلات)، بالإضافة إلى استوديو خدمات رقمية: مواقع إلكترونية، وكلاء ذكاء اصطناعي، أتمتة واتساب، أنظمة حجوزات، وحلول مخصصة.',
      '',
      `⏰ ساعات عمل فريق التفعيل: ${formatAvailabilityText('ar')}`,
      '💬 المبيعات والدعم: +972 59 891 559 (تيليجرام / واتساب)',
      '🤖 أرد على مدار الساعة، والمتابعة البشرية خلال ساعات العمل.',
    ].join('\n');
  },
};
