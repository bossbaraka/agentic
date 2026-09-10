/**
 * نظام الحجوزات — مواعيد التفعيل مع فريق مُريح.
 *
 * في سياق منصة مُريح (B2B) يكون «الحجز» = موعد تفعيل اشتراك العميل مع الفريق.
 * كل الأرقام والمواعيد هنا حتمية (deterministic) ومن مصدر إعدادات واحد
 * (config.booking) — البوت لا يخترع أي موعد أو ساعة عمل:
 *   - التوفر يُحسب من أيام/ساعات العمل + إشغال المواعيد المسجلة.
 *   - لا يوجد موعد «مؤكد» إلا بعد نجاح createBooking.
 *
 * التخزين: ملف JSON ذرّي في data/bookings.json (نفس نمط بقية المخازن).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log, uid } from '../lib/utils.js';
import { getPlan, type PlanId } from './plans.js';

// ─────────────────────────────── الأنواع ───────────────────────────────

export type BookingStatus = 'confirmed' | 'cancelled' | 'completed';

export interface Booking {
  /** معرّف الحجز BKG-XXXXXX */
  ref: string;
  /** الخدمة المحجوزة = الباقة (starter | pro | enterprise) */
  service: PlanId;
  /** التاريخ بصيغة YYYY-MM-DD */
  date: string;
  /** الوقت بصيغة HH:MM */
  time: string;
  fullName?: string;
  restaurantName?: string;
  city?: string;
  tables?: number;
  /** قناة/معرّف العميل (sessionKey) */
  contact: string;
  notes?: string;
  status: BookingStatus;
  createdAt: number;
  updatedAt: number;
  cancelledReason?: string;
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

/** وصف عربي لساعات العمل — يُحقن في الـ prompt وفي get_restaurant_info */
export function formatAvailabilityText(): string {
  const a = availability();
  const days = a.workingDayNames.join('، ');
  return `${days} من ${pad2(a.openHour)}:00 إلى ${pad2(a.closeHour)}:00 (توقيت ${a.timezone === 'Asia/Jerusalem' ? 'القدس' : a.timezone}) — مدة الموعد ${a.slotMinutes} دقيقة.`;
}

// ─────────────────────────────── أدوات التاريخ ───────────────────────────────

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** تاريخ اليوم بصيغة YYYY-MM-DD حسب منطقة النشاط الزمنية */
export function todayISO(): string {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: config.booking.TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return fmt.format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** تاريخ أقصى مدى مسموح للحجز (اليوم + advanceDays) */
export function maxISO(): string {
  const t = parseDateParts(todayISO());
  if (!t) return todayISO();
  const d = new Date(Date.UTC(t.year, t.month - 1, t.day + config.booking.ADVANCE_DAYS));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** الوقت الآن HH:MM حسب المنطقة الزمنية */
export function nowHHMM(): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: config.booking.TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
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
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** يوم الأسبوع لتاريخ معين (0=الأحد … 6=السبت) — دون الاعتماد على منطقة الجهاز */
export function weekdayOf(dateStr: string): number | null {
  const p = parseDateParts(dateStr);
  if (!p) return null;
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

/** قائمة الفتحات الزمنية المتاحة في يوم عمل (كل الأوقات، دون اعتبار الإشغال) */
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

// ─────────────────────────────── المخزن ───────────────────────────────

const BOOKINGS_FILE = () => path.join(config.paths.DATA_DIR, 'bookings.json');

class BookingStore {
  private items: Booking[] | null = null;

  private load(): Booking[] {
    if (this.items) return this.items;
    this.items = [];
    try {
      if (fs.existsSync(BOOKINGS_FILE())) {
        const raw = JSON.parse(fs.readFileSync(BOOKINGS_FILE(), 'utf8')) as Booking[];
        if (Array.isArray(raw)) this.items = raw;
      }
    } catch (err) {
      log.warn(`تعذّر قراءة ملف الحجوزات — بدء نظيف. (${(err as Error).message})`);
    }
    return this.items;
  }

  private flush(): void {
    const file = BOOKINGS_FILE();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.load(), null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  all(): Booking[] {
    return [...this.load()];
  }

  /** الحجوزات النشطة فقط (غير الملغاة) */
  active(): Booking[] {
    return this.load().filter((b) => b.status === 'confirmed');
  }

  byRef(ref: string): Booking | null {
    const r = ref.trim().toUpperCase();
    return this.load().find((b) => b.ref.toUpperCase() === r) ?? null;
  }

  bySession(key: string): Booking[] {
    return this.load()
      .filter((b) => b.contact === key)
      .sort((a, c) => c.createdAt - a.createdAt);
  }

  /** آخر حجز نشط لعميل معين */
  latestActive(key: string): Booking | null {
    return this.active().find((b) => b.contact === key) ?? null;
  }

  /** عدد الحجوزات النشطة في موعد معين (مع تجاهل حجز محدد عند التعديل) */
  countAt(date: string, time: string, ignoreRef?: string): number {
    return this.active().filter(
      (b) => b.date === date && b.time === time && (!ignoreRef || b.ref !== ignoreRef),
    ).length;
  }

  create(input: Omit<Booking, 'ref' | 'status' | 'createdAt' | 'updatedAt'>): Booking {
    const booking: Booking = {
      ...input,
      ref: `BKG-${uid('').slice(-6).toUpperCase()}`,
      status: 'confirmed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.load().push(booking);
    this.flush();
    log.tool(`createBooking → ${booking.ref} | ${booking.service} | ${booking.date} ${booking.time} | ${booking.fullName ?? '?'}`);
    return booking;
  }

  update(ref: string, patch: Partial<Pick<Booking, 'service' | 'date' | 'time' | 'fullName' | 'restaurantName' | 'city' | 'tables' | 'notes' | 'status' | 'cancelledReason'>>): Booking | null {
    const list = this.load();
    const i = list.findIndex((b) => b.ref === ref);
    if (i === -1) return null;
    list[i] = { ...list[i]!, ...patch, updatedAt: Date.now() };
    this.flush();
    return list[i]!;
  }

  cancel(ref: string, reason?: string): Booking | null {
    const updated = this.update(ref, { status: 'cancelled', cancelledReason: reason });
    if (updated) log.tool(`cancelBooking → ${ref}${reason ? ` (${reason.slice(0, 40)})` : ''}`);
    return updated;
  }
}

export const bookingStore = new BookingStore();

// ─────────────────────────────── فحص التوفر ───────────────────────────────

export interface DateAvailability {
  ok: boolean;
  date: string;
  dayName?: string;
  /** سبب عدم التوفر (عربي) */
  reason?: string;
  /** الفتحات المتاحة (بعد خصم الإشغال) */
  slots: string[];
  /** كل فتحات اليوم (للأيام خارج العمل/المنتهية) */
  allSlots?: string[];
}

/** فحص تاريخ: هل هو صالح، وهل يوم عمل، وهل ضمن المدى؟ */
export function dateInfo(dateStr: string): { valid: boolean; error?: string; day?: number; dayName?: string } {
  if (!parseDateParts(dateStr)) {
    return { valid: false, error: 'صيغة التاريخ غير صحيحة — استخدم YYYY-MM-DD (مثل 2026-09-14)' };
  }
  const day = weekdayOf(dateStr)!;
  return { valid: true, day, dayName: DAY_NAMES[day] };
}

/** الفتحات المتاحة فعلًا لتاريخ معين (توقيت + يوم عمل + مدى + إشغال) */
export function availableSlotsForDate(dateStr: string): DateAvailability {
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
      ok: false,
      date: dateStr,
      dayName: info.dayName,
      reason: `هذا اليوم (${info.dayName}) خارج أيام عمل الحجز — نشتغل ${a.workingDayNames.join('، ')}`,
      slots: [],
    };
  }

  const allSlots = slotsForDate(dateStr);
  // لليوم نفسه: نستبعد الفتحات التي مضت أو اقتربت (مهلة الإشعار)
  const now = nowHHMM();
  const minCut = addMinutes(now, a.minNoticeHours * 60);
  const bookable = allSlots.filter((s) => (dateStr > today ? true : s > minCut));

  const free = bookable.filter((s) => bookingStore.countAt(dateStr, s) < a.maxPerSlot);

  return {
    ok: free.length > 0,
    date: dateStr,
    dayName: info.dayName,
    slots: free,
    allSlots: bookable,
    reason: free.length === 0 ? 'لا توجد فتحات متاحة في هذا اليوم' : undefined,
  };
}

/** فحص فتحة محددة (تاريخ + وقت) */
export function checkSlot(dateStr: string, time: string, ignoreRef?: string): { ok: boolean; reason?: string } {
  const info = dateInfo(dateStr);
  if (!info.valid) return { ok: false, reason: info.error };

  const a = availability();
  const slotMatch = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!slotMatch) return { ok: false, reason: 'صيغة الوقت غير صحيحة — استخدم HH:MM (مثل 10:00)' };

  const hh = Number(slotMatch[1]);
  const mm = Number(slotMatch[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return { ok: false, reason: 'وقت غير صالح' };

  const mins = hh * 60 + mm;
  const start = a.openHour * 60;
  const end = a.closeHour * 60;
  if (mins < start || mins + a.slotMinutes > end) {
    return { ok: false, reason: `هذا الوقت خارج ساعات العمل (${pad2(a.openHour)}:00–${pad2(a.closeHour)}:00)` };
  }
  if (mins % a.slotMinutes !== 0) {
    const nearest = Math.round(mins / a.slotMinutes) * a.slotMinutes;
    const nearestStr = `${pad2(Math.floor(nearest / 60))}:${pad2(nearest % 60)}`;
    return { ok: false, reason: `المواعيد تكون كل ${a.slotMinutes} دقيقة — أقرب وقت مناسب: ${nearestStr}` };
  }

  const dayAvail = availableSlotsForDate(dateStr);
  if (!dayAvail.ok) return { ok: false, reason: dayAvail.reason };

  const today = todayISO();
  if (dateStr === today && mins <= addMinutesToInt(nowHHMM(), a.minNoticeHours * 60)) {
    return { ok: false, reason: 'هذا الوقت اقترب — يلزم حجز أبكر قليلًا' };
  }

  if (bookingStore.countAt(dateStr, time, ignoreRef) >= a.maxPerSlot) {
    return { ok: false, reason: 'هذا الموعد محجوز بالكامل — اختر وقتًا آخر من الفتحات المتاحة' };
  }

  return { ok: true };
}

/** أقرب أيام العمل المتاحة (مع أول فتحاتها) — للرد عندما لا يحدد العميل تاريخًا */
export function nextAvailableDays(limit = 3): { date: string; dayName: string; slots: string[] }[] {
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
    const res = availableSlotsForDate(d);
    if (res.ok && res.slots.length > 0) {
      out.push({ date: d, dayName: res.dayName!, slots: res.slots.slice(0, 3) });
    }
  }
  return out;
}

// ─────────────────────────────── أدوات مساعدة ───────────────────────────────

function addMinutes(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const total = (h ?? 0) * 60 + (m ?? 0) + minutes;
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

function addMinutesToInt(hhmm: string, minutes: number): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0) + minutes;
}

/** اسم الباقة (الخدمة) بالعربية */
export function serviceName(planId: PlanId): string {
  return getPlan(planId).name;
}

/** ملخص عربي لحجز — يُعرض على العميل أو يُرسل للمدير */
export function bookingSummary(b: Booking): string {
  const lines = [
    `*حجز موعد تفعيل* — ${b.ref}`,
    `📅 التاريخ: ${b.date} · الساعة: ${b.time}`,
    `📦 الخدمة: ${serviceName(b.service)}`,
  ];
  if (b.restaurantName) lines.push(`🍽️ المطعم: ${b.restaurantName}${b.city ? ` — ${b.city}` : ''}`);
  if (b.tables && b.tables > 0) lines.push(`🪑 الطاولات: ${b.tables}`);
  if (b.fullName) lines.push(`👤 العميل: ${b.fullName}`);
  if (b.notes) lines.push(`📝 ملاحظات: ${b.notes}`);
  return lines.join('\n');
}
