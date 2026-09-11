/**
 * منطق الحجوزات النقي (Domain Logic) — مواعيد تفعيل فريق مُريح.
 *
 * كل الأرقام والمواعيد حتمية من مصدر إعدادات واحد (config.booking):
 *   - التوفر يُحسب من أيام/ساعات العمل + إشغال المواعيد (تُمرّر له كمدخل).
 *   - لا تخزين هنا إطلاقًا: الإدخال/الإخراج عبر src/db/repos/bookings.ts.
 *   - منع الحجز المزدوج يُفرض أيضًا بقيد UNIQUE في قاعدة البيانات.
 *
 * الحالات: PENDING → CONFIRMED → COMPLETED
 *                                  └→ NO_SHOW
 *               أي حالة نشطة ─→ CANCELLED
 */
import { config } from '../config.js';
import { getPlan, type PlanId } from './plans.js';

export type BookingStatus = 'PENDING' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';

export interface SlotOccupancy {
  slot_date: string;
  slot_time: string;
}

export interface AvailabilityInfo {
  timezone: string;
  workingDays: number[];
  workingDayNames: string[];
  openHour: number;
  closeHour: number;
  slotMinutes: number;
  maxPerSlot: number;
  advanceDays: number;
  minNoticeHours: number;
}

export const DAY_NAMES = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
export const DAY_NAMES_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ─────────────────────────────── الإعدادات ───────────────────────────────

export function availability(): AvailabilityInfo {
  const b = config.booking;
  const workingDays = [...b.WORKING_DAYS].sort((a, c) => a - c);
  return {
    timezone: b.TIMEZONE,
    workingDays,
    workingDayNames: workingDays.map((d) => DAY_NAMES[d]!),
    openHour: b.OPEN_HOUR,
    closeHour: b.CLOSE_HOUR,
    slotMinutes: b.SLOT_MINUTES,
    maxPerSlot: b.MAX_PER_SLOT,
    advanceDays: b.ADVANCE_DAYS,
    minNoticeHours: b.MIN_NOTICE_HOURS,
  };
}

export function formatAvailabilityText(lang: 'ar' | 'en' = 'ar'): string {
  const a = availability();
  const tzLabel = a.timezone === 'Asia/Jerusalem' ? (lang === 'en' ? 'Jerusalem' : 'القدس') : a.timezone;
  if (lang === 'en') {
    const days = workingDayNamesEn(a.workingDays).join(', ');
    return `${days}, ${pad2(a.openHour)}:00–${pad2(a.closeHour)}:00 (${tzLabel} time) — each appointment is ${a.slotMinutes} minutes.`;
  }
  return `${a.workingDayNames.join('، ')} من ${pad2(a.openHour)}:00 إلى ${pad2(a.closeHour)}:00 (توقيت ${tzLabel}) — مدة الموعد ${a.slotMinutes} دقيقة.`;
}

function workingDayNamesEn(days: number[]): string[] {
  return days.map((d) => DAY_NAMES_EN[d]!);
}

// ─────────────────────────────── أدوات التاريخ ───────────────────────────────

const pad2 = (n: number): string => String(n).padStart(2, '0');

export function todayISO(): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: config.booking.TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function maxISO(): string {
  const t = parseDateParts(todayISO());
  if (!t) return todayISO();
  const d = new Date(Date.UTC(t.year, t.month - 1, t.day + config.booking.ADVANCE_DAYS));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function nowHHMM(): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: config.booking.TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date());
    const h = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
    return `${h}:${m}`;
  } catch {
    const d = new Date();
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
}

interface DateParts { year: number; month: number; day: number }

function parseDateParts(dateStr: string): DateParts | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((dateStr ?? '').trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day };
}

export function isValidDate(dateStr: string): boolean {
  return parseDateParts(dateStr) !== null;
}

export function weekdayOf(dateStr: string): number | null {
  const p = parseDateParts(dateStr);
  if (!p) return null;
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

export function slotsForDate(dateStr: string): string[] {
  const a = availability();
  const start = a.openHour * 60;
  const end = a.closeHour * 60;
  const slots: string[] = [];
  for (let m = start; m < end; m += a.slotMinutes) {
    slots.push(`${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`);
  }
  return slots;
}

/**
 * epoch ms لموعد محلي بمنطقة النشاط (DST-aware):
 * نحسب إزاحة المنطقة في ذلك اليوم/الساعة عبر Intl ثم نرجع اللحظة الحقيقية.
 */
export function slotEpochMs(dateStr: string, time: string): number | null {
  const p = parseDateParts(dateStr);
  const tm = /^(\d{1,2}):(\d{2})$/.exec((time ?? '').trim());
  if (!p || !tm) return null;
  const hour = Number(tm[1]);
  const minute = Number(tm[2]);
  if (hour > 23 || minute > 59) return null;

  const tz = config.booking.TIMEZONE;
  // تقدير أولي ثم تصحيح الإزاحة
  const guess = Date.UTC(p.year, p.month - 1, p.day, hour, minute);
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(guess));
    const map: Record<string, number> = {};
    for (const part of parts) if (part.type !== 'literal') map[part.type] = Number(part.value);
    const asUTC = Date.UTC(
      map.year!, (map.month! - 1) % 12, map.day!,
      (map.hour! % 24), map.minute!, map.second!,
    );
    return guess - (asUTC - guess);
  } catch {
    return guess;
  }
}

// ─────────────────────────────── فحص التوفر ───────────────────────────────

export interface DateAvailability {
  ok: boolean;
  date: string;
  dayName?: string;
  reason?: string;
  slots: string[];
  allSlots?: string[];
}

export function dateInfo(dateStr: string): { valid: boolean; error?: string; day?: number; dayName?: string } {
  if (!parseDateParts(dateStr)) {
    return { valid: false, error: 'صيغة التاريخ غير صحيحة — استخدم YYYY-MM-DD (مثل 2026-09-14)' };
  }
  const day = weekdayOf(dateStr)!;
  return { valid: true, day, dayName: DAY_NAMES[day] };
}

function addMinutesToInt(hhmm: string, minutes: number): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0) + minutes;
}

/**
 * الفتحات المتاحة لتاريخ ما بعد خصم الإشغال المُمرَّر.
 * @param occupied الفتحات المشغولة فعلاً (PENDING/CONFIRMED) من المستودع
 */
export function availableSlotsForDate(
  dateStr: string,
  occupied: SlotOccupancy[] = [],
): DateAvailability {
  const info = dateInfo(dateStr);
  if (!info.valid) return { ok: false, date: dateStr, reason: info.error, slots: [] };

  const a = availability();
  const today = todayISO();
  const max = maxISO();

  if (dateStr < today) {
    return { ok: false, date: dateStr, dayName: info.dayName, reason: 'هذا التاريخ مضى بالفعل — اختر تاريخ اليوم أو لاحقًا', slots: [] };
  }
  if (dateStr > max) {
    return { ok: false, date: dateStr, dayName: info.dayName, reason: `الحجز متاح حتى ${max} فقط — اختر تاريخًا ضمن المدى`, slots: [] };
  }
  if (!a.workingDays.includes(info.day!)) {
    return {
      ok: false, date: dateStr, dayName: info.dayName,
      reason: `هذا اليوم خارج أيام عمل الحجز — نشتغل ${a.workingDayNames.join('، ')}`,
      slots: [],
    };
  }

  const allSlots = slotsForDate(dateStr);
  const now = nowHHMM();
  const minCut = addMinutesToInt(now, a.minNoticeHours * 60);
  const bookable = allSlots.filter((s) => (dateStr > today ? true : toMinutes(s) > minCut));

  const counts = new Map<string, number>();
  for (const o of occupied) {
    if (o.slot_date === dateStr) counts.set(o.slot_time, (counts.get(o.slot_time) ?? 0) + 1);
  }
  const free = bookable.filter((s) => (counts.get(s) ?? 0) < a.maxPerSlot);

  return {
    ok: free.length > 0,
    date: dateStr,
    dayName: info.dayName,
    slots: free,
    allSlots: bookable,
    reason: free.length === 0 ? 'لا توجد فتحات متاحة في هذا اليوم' : undefined,
  };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** فحص فتحة محددة مع الإشغال المُمرَّر (ignoreRef يستثني حجزًا قائمًا عند التعديل) */
export function checkSlot(
  dateStr: string,
  time: string,
  occupied: SlotOccupancy[] = [],
  ignoreId?: number,
): { ok: boolean; reason?: string } {
  const info = dateInfo(dateStr);
  if (!info.valid) return { ok: false, reason: info.error };

  const a = availability();
  const slotMatch = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!slotMatch) return { ok: false, reason: 'صيغة الوقت غير صحيحة — استخدم HH:MM (مثل 10:00)' };

  const hh = Number(slotMatch[1]);
  const mm = Number(slotMatch[2]);
  if (hh > 23 || mm > 59) return { ok: false, reason: 'وقت غير صالح' };

  const mins = hh * 60 + mm;
  const start = a.openHour * 60;
  const end = a.closeHour * 60;
  if (mins < start || mins + a.slotMinutes > end) {
    return { ok: false, reason: `هذا الوقت خارج ساعات العمل (${pad2(a.openHour)}:00–${pad2(a.closeHour)}:00)` };
  }
  if (mins % a.slotMinutes !== 0) {
    const nearest = Math.round(mins / a.slotMinutes) * a.slotMinutes;
    return { ok: false, reason: `المواعيد كل ${a.slotMinutes} دقيقة — أقرب وقت: ${pad2(Math.floor(nearest / 60))}:${pad2(nearest % 60)}` };
  }

  const dayAvail = availableSlotsForDate(dateStr, occupied);
  if (!dayAvail.ok) return { ok: false, reason: dayAvail.reason };

  const today = todayISO();
  if (dateStr === today && mins <= addMinutesToInt(nowHHMM(), a.minNoticeHours * 60)) {
    return { ok: false, reason: 'هذا الوقت اقترب — يلزم حجز أبكر قليلًا' };
  }

  const busy = occupied
    .filter((o) => o.slot_date === dateStr && o.slot_time === time)
    .filter((o) => !(o as unknown as { id?: number }).id || (o as unknown as { id?: number }).id !== ignoreId).length;
  if (busy >= a.maxPerSlot) {
    return { ok: false, reason: 'هذا الموعد محجوز بالكامل — اختر وقتًا آخر من الفتحات المتاحة' };
  }
  return { ok: true };
}

/** أقرب أيام العمل المتاحة (مع أول فتحاتها) */
export function nextAvailableDays(
  limit = 3,
  occupied: SlotOccupancy[] = [],
): { date: string; dayName: string; slots: string[] }[] {
  const a = availability();
  const today = todayISO();
  const out: { date: string; dayName: string; slots: string[] }[] = [];

  const t = parseDateParts(today)!;
  let cursor = new Date(Date.UTC(t.year, t.month - 1, t.day));
  let guard = 0;
  while (out.length < limit && guard < 60) {
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate() + 1));
    guard++;
    const d = `${cursor.getUTCFullYear()}-${pad2(cursor.getUTCMonth() + 1)}-${pad2(cursor.getUTCDate())}`;
    if (d > maxISO()) break;
    const res = availableSlotsForDate(d, occupied);
    if (res.ok && res.slots.length > 0) {
      out.push({ date: d, dayName: res.dayName!, slots: res.slots.slice(0, a.maxPerSlot + 2) });
    }
  }
  return out;
}

/** تسمية الحالة بالعربية */
export function bookingStatusLabelAr(status: BookingStatus): string {
  return {
    PENDING: 'قيد التأكيد',
    CONFIRMED: 'مؤكّد',
    COMPLETED: 'مكتمل',
    CANCELLED: 'ملغى',
    NO_SHOW: 'بدون حضور',
  }[status];
}

export function bookingStatusIcon(status: BookingStatus): string {
  return { PENDING: '⏳', CONFIRMED: '✅', COMPLETED: '🎉', CANCELLED: '❌', NO_SHOW: '🚫' }[status];
}

/** اسم الخدمة القديمة (الباقة) — يستخدم كنسخة احتياطية عند غياب كتالوج DB */
export function planName(planId: string | null | undefined): string {
  if (planId === 'starter' || planId === 'pro' || planId === 'enterprise') return getPlan(planId).name;
  return planId ?? 'خدمة';
}

export type { PlanId };
