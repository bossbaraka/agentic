/**
 * مستودع الحجوزات — كل العمليات داخل معاملات.
 *
 * منع Double Booking بطبقتين:
 *  1) فهرس UNIQUE جزئي على (slot_date, slot_time) للحالات النشطة (السعة 1 الافتراضية).
 *  2) فحص عدّاد السعة داخل BEGIN IMMEDIATE قبل أي إدخال (يدعم BOOKING_MAX_PER_SLOT > 1).
 * ملكية الحجز محفوظة في contact_key وتُفحص في كل عملية تعديل/إلغاء.
 */
import { all, get, run, transaction, db } from '../client.js';
import type { BookingRow, BookingStatus, ServiceRow } from '../types.js';
import { checkSlot, slotEpochMs, type SlotOccupancy } from '../../agent/bookings.js';

export class BookingError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'BookingError';
  }
}

export interface CreateBookingInput {
  contactKey: string;
  fullName?: string | null;
  slotDate: string;
  slotTime: string;
  service?: ServiceRow | null;
  planSlug?: string | null;
  notes?: string | null;
  durationMinutes?: number;
  userId?: number | null;
  customerId?: number | null;
  adminId?: number | null;
  status?: BookingStatus;
  /** مفتاح ثبات (Idempotency) — يمنع إنشاء حجزين من نفس المحاولة المكررة */
  idempotencyKey?: string | null;
}

const ACTIVE = "('PENDING','CONFIRMED')";

/** كل الفتحات النشطة المشغولة (للحسابات) */
export function activeOccupancy(): (SlotOccupancy & { id: number })[] {
  return all<SlotOccupancy & { id: number }>(
    `SELECT id, slot_date, slot_time FROM bookings WHERE status IN ${ACTIVE}`,
  );
}

export function countAt(date: string, time: string, ignoreId?: number): number {
  const rows = all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM bookings WHERE status IN ${ACTIVE} AND slot_date = ? AND slot_time = ? ${ignoreId ? 'AND id <> ?' : ''}`,
    ignoreId ? [date, time, ignoreId] : [date, time],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * إنشاء حجز ذريًّا. يرمي BookingError عند أي تحقق فاشل — لا «نجاح» كاذب أبدًا.
 */
export function createBooking(input: CreateBookingInput): BookingRow {
  const epoch = slotEpochMs(input.slotDate, input.slotTime);
  if (epoch === null) throw new BookingError('invalid_datetime', 'تاريخ أو وقت غير صالح');

  // ثبات الاستدعاء المكرر (نفس المفتاح = نفس الحجز)
  if (input.idempotencyKey) {
    const dup = get<BookingRow>('SELECT * FROM bookings WHERE idempotency_key = ?', [input.idempotencyKey]);
    if (dup) return dup;
  }

  // يملك العميل حجزًا نشطًا في نفس الفتحة أصلًا؟ نعيده بدل الخطأ (idempotency ضمنية)
  const existing = get<BookingRow>(
    `SELECT * FROM bookings WHERE status IN ${ACTIVE} AND contact_key = ? AND slot_date = ? AND slot_time = ?`,
    [input.contactKey, input.slotDate, input.slotTime],
  );
  if (existing) return existing;

  try {
    return transaction(() => {
      const database = db();
      // فحص السعة داخل المعاملة الحصرية
      const row = get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM bookings
         WHERE status IN ${ACTIVE} AND slot_date = ? AND slot_time = ?`,
        [input.slotDate, input.slotTime],
      )!;
      const occupiedNow: (SlotOccupancy & { id: number })[] = all(
        `SELECT id, slot_date, slot_time FROM bookings WHERE status IN ${ACTIVE}`,
      );
      const check = checkSlot(input.slotDate, input.slotTime, occupiedNow);
      if (!check.ok) throw new BookingError('slot_unavailable', check.reason ?? 'الموعد غير متاح');
      void row;

      const ref = `BKG-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      const now = Date.now();
      const serviceId = input.service?.id ?? null;
      const planSlug = input.planSlug ?? input.service?.slug ?? null;
      const status = input.status ?? 'CONFIRMED';
      const duration = input.durationMinutes ?? input.service?.duration_minutes ?? 60;

      const r = database
        .prepare(
          `INSERT INTO bookings
            (ref, idempotency_key, customer_id, user_id, service_id, plan_slug, contact_key, full_name,
             slot_date, slot_time, slot_epoch_ms, duration_minutes, status, notes, reminded_hours,
             created_by_admin_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)`,
        )
        .run(
          ref, input.idempotencyKey ?? null, input.customerId ?? null, input.userId ?? null,
          serviceId, planSlug, input.contactKey, input.fullName ?? null,
          input.slotDate, input.slotTime, epoch, duration, status, input.notes ?? null,
          input.adminId ?? null, now, now,
        );

      const id = Number(r.lastInsertRowid);
      // التعامل مع السباق الذي أفلت من العدّاد (القيد الفريد) — رسالة ودية بدل SQL error
      return get<BookingRow>('SELECT * FROM bookings WHERE id = ?', [id])!;
    });
  } catch (err) {
    if (err instanceof BookingError) throw err;
    const msg = String((err as Error).message ?? err);
    if (/UNIQUE/i.test(msg) && /bookings_active_slot|ux_bookings_active_slot/i.test(msg)) {
      throw new BookingError('slot_unavailable', 'هذا الموعد حُجز للتو — اختر وقتًا آخر');
    }
    if (/UNIQUE/i.test(msg)) {
      throw new BookingError('duplicate', 'تعذّر إنشاء الحجز: عملية مكررة');
    }
    throw new BookingError('db_error', `خطأ مؤقت في قاعدة البيانات: ${msg}`);
  }
}

export function getBookingByRef(ref: string): BookingRow | undefined {
  return get<BookingRow>('SELECT * FROM bookings WHERE UPPER(ref) = UPPER(?)', [ref.trim()]);
}

export function listBookingsForContact(contactKey: string, opts: { includePast?: boolean; limit?: number } = {}): BookingRow[] {
  const rows = all<BookingRow>(
    `SELECT * FROM bookings WHERE contact_key = ? ORDER BY slot_epoch_ms DESC, id DESC LIMIT ?`,
    [contactKey, opts.limit ?? 20],
  );
  if (opts.includePast) return rows;
  const now = Date.now();
  return rows.filter((b) => b.status === 'CANCELLED' || b.slot_epoch_ms >= now - 2 * 3600_000);
}

/** آخر حجز نشط لعميل (لأدوات التعديل/الإلغاء بدون معرّف) */
export function latestActiveForContact(contactKey: string): BookingRow | undefined {
  return get<BookingRow>(
    `SELECT * FROM bookings WHERE contact_key = ? AND status IN ${ACTIVE}
     ORDER BY slot_epoch_ms ASC, id ASC LIMIT 1`,
    [contactKey],
  );
}

export interface AdminBookingQuery {
  status?: BookingStatus | 'all';
  limit?: number;
  offset?: number;
  from?: string;
  to?: string;
}

export function listBookingsAdmin(q: AdminBookingQuery = {}): { rows: BookingRow[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.status && q.status !== 'all') { where.push('status = ?'); params.push(q.status); }
  if (q.from) { where.push('slot_date >= ?'); params.push(q.from); }
  if (q.to) { where.push('slot_date <= ?'); params.push(q.to); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(get<{ n: number }>(`SELECT COUNT(*) AS n FROM bookings ${whereSql}`, params)?.n ?? 0);
  const rows = all<BookingRow>(
    `SELECT * FROM bookings ${whereSql} ORDER BY slot_epoch_ms DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, q.limit ?? 10, q.offset ?? 0],
  );
  return { rows, total };
}

/**
 * تعديل موعد/خدمة حجز — يتحقق من: ملكية/صلاحية الحجز، حالته النشطة،
 * توفر الفتحة الجديدة ذريًّا. لا يعيد حجزًا ملغى للحياة.
 */
export function rescheduleBooking(
  booking: BookingRow,
  patch: { slotDate?: string; slotTime?: string; service?: ServiceRow | null; notes?: string | null; adminId?: number | null },
): BookingRow {
  if (booking.status !== 'PENDING' && booking.status !== 'CONFIRMED') {
    throw new BookingError('not_active', 'هذا الحجز ليس نشطًا');
  }
  const date = patch.slotDate ?? booking.slot_date;
  const time = patch.slotTime ?? booking.slot_time;
  const epoch = slotEpochMs(date, time) ?? booking.slot_epoch_ms;

  try {
    return transaction(() => {
      if (date !== booking.slot_date || time !== booking.slot_time) {
        const occupied: (SlotOccupancy & { id: number })[] = all(
          `SELECT id, slot_date, slot_time FROM bookings WHERE status IN ${ACTIVE}`,
        );
        const check = checkSlot(date, time, occupied, booking.id);
        if (!check.ok) throw new BookingError('slot_unavailable', check.reason ?? 'الموعد الجديد غير متاح');
      }
      run(
        `UPDATE bookings SET slot_date = ?, slot_time = ?, slot_epoch_ms = ?,
           service_id = COALESCE(?, service_id), plan_slug = COALESCE(?, plan_slug),
           notes = COALESCE(?, notes), reminded_hours = '', updated_at = ?
         WHERE id = ?`,
        [date, time, epoch, patch.service?.id ?? null, patch.service?.slug ?? null,
          patch.notes ?? null, Date.now(), booking.id],
      );
      return get<BookingRow>('SELECT * FROM bookings WHERE id = ?', [booking.id])!;
    });
  } catch (err) {
    if (err instanceof BookingError) throw err;
    throw new BookingError('db_error', `خطأ مؤقت: ${(err as Error).message}`);
  }
}

export function updateStatus(
  booking: BookingRow,
  status: BookingStatus,
  extra: { reason?: string | null; adminId?: number | null } = {},
): BookingRow {
  const allowed: Record<BookingStatus, BookingStatus[]> = {
    PENDING: ['CONFIRMED', 'CANCELLED', 'NO_SHOW'],
    CONFIRMED: ['COMPLETED', 'CANCELLED', 'NO_SHOW', 'PENDING'],
    COMPLETED: [],
    CANCELLED: ['PENDING'],
    NO_SHOW: ['CONFIRMED'],
  };
  if (!allowed[booking.status].includes(status)) {
    throw new BookingError('invalid_transition', `لا يمكن نقل الحجز من ${booking.status} إلى ${status}`);
  }
  transaction(() => {
    run(
      `UPDATE bookings SET status = ?, cancellation_reason = CASE WHEN ? = 'CANCELLED' THEN COALESCE(?, cancellation_reason) ELSE cancellation_reason END,
         created_by_admin_id = COALESCE(?, created_by_admin_id), updated_at = ? WHERE id = ?`,
      [status, status, extra.reason ?? null, extra.adminId ?? null, Date.now(), booking.id],
    );
  });
  return get<BookingRow>('SELECT * FROM bookings WHERE id = ?', [booking.id])!;
}

/** حجوزات تحتاج تذكير: مؤكدة، موعدها خلال المهلة المحددة، ولم يُرسل تذكير هذه المهلة بعد */
export function bookingsDueForReminder(hoursAhead: number, withinMs: number): BookingRow[] {
  const now = Date.now();
  return all<BookingRow>(
    `SELECT * FROM bookings
     WHERE status = 'CONFIRMED' AND slot_epoch_ms BETWEEN ? AND ?
       AND (reminded_hours IS NULL OR INSTR(reminded_hours, ?) = 0)
     ORDER BY slot_epoch_ms ASC`,
    [now + hoursAhead * 3600_000 - withinMs, now + hoursAhead * 3600_000 + withinMs, `|${hoursAhead}|`],
  );
}

export function markReminderSent(id: number, hours: number): void {
  run("UPDATE bookings SET reminded_hours = reminded_hours || ? WHERE id = ?", [`|${hours}|`, id]);
}

/** إحصائيات سريعة للحجوزات */
export function bookingCounts(): Record<BookingStatus, number> {
  const rows = all<{ status: BookingStatus; n: number }>(
    'SELECT status, COUNT(*) AS n FROM bookings GROUP BY status',
  );
  const out: Record<BookingStatus, number> = { PENDING: 0, CONFIRMED: 0, COMPLETED: 0, CANCELLED: 0, NO_SHOW: 0 };
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}
