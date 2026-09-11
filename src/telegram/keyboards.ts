/** بُناة لوحات المفاتيح (Reply دائمة + Inline للتنقل) */
import type { UiLang } from '../lib/i18n.js';
import { t } from '../lib/i18n.js';
import type { TgInlineButton, TgInlineKeyboard } from './client.js';

const btn = (text: string, callback_data: string): TgInlineButton => ({ text, callback_data });

/** لوحة المفاتيح الدائمة أسفل صندوق الكتابة — تتغير حسب اللغة */
export function mainReplyKeyboard(lang: UiLang): string[][] {
  return [
    [t(lang, 'menu.home'), t(lang, 'menu.services')],
    [t(lang, 'menu.orders'), t(lang, 'menu.bookings')],
    [t(lang, 'menu.support'), t(lang, 'menu.about')],
  ];
}

/** أزرار الشاشة الرئيسية */
export function homeInline(lang: UiLang, isAdmin = false): TgInlineKeyboard {
  const rows: TgInlineKeyboard = [
    [btn(t(lang, 'home.services'), 'm'), btn(t(lang, 'home.book'), 'bk')],
    [btn(t(lang, 'home.orders'), 'odl'), btn(t(lang, 'home.bookings'), 'bk')],
    [btn(t(lang, 'home.support'), 'sp'), btn(t(lang, 'home.about'), 'ab')],
  ];
  if (isAdmin) rows.push([btn('🛠 لوحة الإدارة', 'a:menu')]);
  return rows;
}

/** جذر الخدمات: قائمة التصنيفات */
export function categoriesInline(groups: { category: { slug: string; name_ar: string; name_en: string }; services: unknown[] }[], lang: UiLang): TgInlineKeyboard {
  const rows: TgInlineKeyboard = groups.map((g) => [
    btn(lang === 'en' && g.category.name_en ? g.category.name_en : g.category.name_ar, `c:${g.category.slug}`),
  ]);
  rows.push([btn(t(lang, 'common.back_home'), 'h')]);
  return rows;
}

/** قائمة خدمات تصنيف مع ترقيم صفحات */
export function servicesInline(
  items: { slug: string; name: string }[],
  categorySlug: string,
  page: number,
  pages: number,
  lang: UiLang,
): TgInlineKeyboard {
  const rows: TgInlineKeyboard = items.map((s) => [btn(s.name, `s:${s.slug}`)]);
  const nav: TgInlineButton[] = [];
  if (page > 0) nav.push(btn(t(lang, 'services.prev'), `c:${categorySlug}:${page - 1}`));
  if (page < pages - 1) nav.push(btn(t(lang, 'services.next'), `c:${categorySlug}:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([btn(t(lang, 'services.back'), 'm'), btn(t(lang, 'common.back_home'), 'h')]);
  return rows;
}

export function serviceInline(slug: string, categorySlug: string, bookable: boolean, lang: UiLang): TgInlineKeyboard {
  const rows: TgInlineKeyboard = [];
  rows.push([bookable ? btn(t(lang, 'services.book_slot'), `b:${slug}`) : btn(t(lang, 'services.request'), `o:${slug}`)]);
  rows.push([btn(t(lang, 'services.back'), `c:${categorySlug}`), btn(t(lang, 'common.back_home'), 'h')]);
  return rows;
}

/** منتقي الأيام (3 أعمدة) */
export function datePickerInline(slug: string, days: { date: string; dayName: string }[], page: number, lang: UiLang): TgInlineKeyboard {
  const rows: TgInlineKeyboard = [];
  const cols = 3;
  for (let i = 0; i < days.length; i += cols) {
    rows.push(days.slice(i, i + cols).map((d) => {
      const day = String(d.date.slice(8));
      return btn(`${day} ${d.dayName}`, `d:${slug}:${d.date}`);
    }));
  }
  const nav: TgInlineButton[] = [];
  if (page > 0) nav.push(btn(t(lang, 'services.prev'), `dp:${slug}:${page - 1}`));
  if (page === 0) nav.push(btn(t(lang, 'services.next'), `dp:${slug}:1`));
  if (nav.length) rows.push(nav);
  rows.push([btn(t(lang, 'services.back'), `s:${slug}`), btn(t(lang, 'common.back_home'), 'h')]);
  return rows;
}

/** منتقي الأوقات (3 أعمدة) */
export function timePickerInline(slug: string, date: string, slots: string[], lang: UiLang): TgInlineKeyboard {
  const rows: TgInlineKeyboard = [];
  const cols = 3;
  for (let i = 0; i < slots.length; i += cols) {
    rows.push(slots.slice(i, i + cols).map((time) => btn(time, `t:${slug}:${date}:${time.replace(':', '')}`)));
  }
  rows.push([btn(t(lang, 'services.back'), `b:${slug}`), btn(t(lang, 'common.back_home'), 'h')]);
  return rows;
}

export function confirmInline(yesCb: string, noCb: string, yesLabel: string, noLabel: string): TgInlineKeyboard {
  return [[btn(yesLabel, yesCb), btn(noLabel, noCb)]];
}

export function bookingDetailInline(ref: string, canManage: boolean, lang: UiLang): TgInlineKeyboard {
  const rows: TgInlineKeyboard = [];
  if (canManage) rows.push([btn(t(lang, 'booking.reschedule'), `r:${ref}`), btn(t(lang, 'booking.cancel_b'), `x:${ref}`)]);
  rows.push([btn(t(lang, 'booking.list_title').split(' ')[0] ?? '📅', 'bk'), btn(t(lang, 'common.back_home'), 'h')]);
  return rows;
}

export function bookingsListInline(rows: { ref: string; slot_date: string; slot_time: string }[], lang: UiLang): TgInlineKeyboard {
  const kb: TgInlineKeyboard = rows.slice(0, 8).map((b) => [btn(`${b.ref} — ${b.slot_date} ${b.slot_time}`, `i:${b.ref}`)]);
  kb.push([btn(t(lang, 'common.back_home'), 'h')]);
  return kb;
}

export function ordersListInline(rows: { ref: string }[], lang: UiLang): TgInlineKeyboard {
  const kb: TgInlineKeyboard = rows.slice(0, 8).map((o) => [btn(o.ref, `od:${o.ref}`)]);
  kb.push([btn(t(lang, 'common.back_home'), 'h')]);
  return kb;
}

export function backHomeInline(lang: UiLang): TgInlineKeyboard {
  return [[btn(t(lang, 'common.back_home'), 'h')]];
}

export function supportInline(lang: UiLang): TgInlineKeyboard {
  return [
    [btn(t(lang, 'support.human'), 'sh')],
    [btn(t(lang, 'common.back_home'), 'h')],
  ];
}

export function aboutInline(lang: UiLang): TgInlineKeyboard {
  return [
    [btn(lang === 'en' ? '🌐 العربية' : '🌐 English', `lg:${lang === 'en' ? 'ar' : 'en'}`)],
    [btn(t(lang, 'menu.support'), 'sp'), btn(t(lang, 'common.back_home'), 'h')],
  ];
}
