/**
 * خدمة الإشعارات — طابور دائم في القاعدة + عامل داخل العملية.
 *
 * لماذا طابور بدل الإرسال المباشر داخل معالج تيليجرام؟
 *  - المهام الثقيلة (تذكيرات آجلة، تنبيهات فريق، إعادة محاولة) لا تعطل الرد.
 *  - فشل قناة لا يُسقط العملية؛ المحاولة بتراجع أُسي ثم FAILED قابل للملاحظة.
 *  - كل محاولة وأخطائها مسجلة في جدول notifications وفي السجلات.
 */
import { config } from '../config.js';
import { log } from '../lib/utils.js';
import {
  dueNotifications,
  enqueueNotification,
  markFailed,
  markProcessing,
  markSent,
} from '../db/repos/notifications.js';
import { run as dbRun, get as dbGet, all as dbAll } from '../db/client.js';
import { sendOutbound, notifyHuman, notifyManager } from '../channels/send.js';
import type { NotificationRow } from '../db/types.js';
import { parseJson } from '../db/client.js';

class NotificationService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  /** إدراج إشعار عام */
  enqueue(input: {
    kind: string;
    channel?: 'tg' | 'wa' | null;
    targetKey?: string | null;
    subject?: string;
    payload: Record<string, unknown>;
    runAt?: number;
    maxAttempts?: number;
  }): number {
    return enqueueNotification({ ...input, channel: input.channel ?? null });
  }

  /** رسالة لعميل (تذكير أو متابعة) */
  customer(contactKey: string, text: string, opts: { runAt?: number; kind?: string; extra?: Record<string, unknown> } = {}): number {
    return this.enqueue({
      kind: opts.kind ?? 'customer_message',
      targetKey: contactKey,
      payload: { key: contactKey, text, ...(opts.extra ?? {}) },
      runAt: opts.runAt,
    });
  }

  /** تنبيه الفريق (مدير أو موظف مناوب) */
  staffAlert(scope: 'manager' | 'human', note: string, extra: Record<string, unknown> = {}): number {
    return this.enqueue({
      kind: 'staff_alert',
      subject: note.slice(0, 120),
      payload: { scope, note, ...extra },
    });
  }

  /** إلغاء تذكيرات حجز معيّن (عند تعديله/إلغائه) */
  cancelTargeted(kind: string, bookingId: number): void {
    try {
      dbRun(
        `UPDATE notifications SET status = 'CANCELLED', updated_at = ?
         WHERE kind = ? AND status IN ('PENDING','PROCESSING')
           AND CAST(json_extract(payload, '$.bookingId') AS INTEGER) = ?`,
        [Date.now(), kind, bookingId],
      );
    } catch (err) {
      log.warn(`تعذّر إلغاء إشعارات الحجز ${bookingId}: ${(err as Error).message}`);
    }
  }

  /** عدد الرسائل العالقة (للفحص الصحي) */
  pending(): number {
    return Number(dbGet<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE status = 'PENDING'")?.n ?? 0);
  }

  failed(limit = 20): NotificationRow[] {
    return dbAll<NotificationRow>('SELECT * FROM notifications WHERE status = ? ORDER BY updated_at DESC LIMIT ?', ['FAILED', limit]);
  }

  // ───────────────────────── العامل ─────────────────────────

  start(): void {
    if (!config.notifications.ENABLED) {
      log.info('🔕 عامل الإشعارات معطّل (NOTIFICATIONS_ENABLED=false)');
      return;
    }
    if (this.timer) return;
    // أول دورة سريعة ثم دورية
    setTimeout(() => void this.tick(), 1500)?.unref?.();
    this.timer = setInterval(() => void this.tick(), config.notifications.WORKER_INTERVAL_MS);
    this.timer.unref?.();
    log.ok(`🔔 عامل الإشعارات يعمل (دورة كل ${config.notifications.WORKER_INTERVAL_MS}ms)`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** دورة معالجة واحدة — متزامنة لتفادي ازدواج إرسال نفس الصف */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const due = dueNotifications(12);
      for (const n of due) {
        markProcessing(n.id);
        try {
          await this.dispatch(n);
          markSent(n.id);
        } catch (err) {
          markFailed(n.id, (err as Error).message);
          log.warn(`🔔 فشل إشعار #${n.id} (${n.kind}): ${(err as Error).message}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** موجه أنواع الإشعارات إلى قنوات الإرسال */
  private async dispatch(n: NotificationRow): Promise<void> {
    const payload = parseJson<Record<string, unknown>>(n.payload, {});
    switch (n.kind) {
      case 'staff_alert': {
        const scope = payload.scope === 'human' ? 'human' : 'manager';
        const note = String(payload.note ?? n.subject ?? '');
        if (scope === 'manager') {
          const ok = await notifyManager(note, String(payload.bookingRef ?? payload.orderRef ?? ''));
          if (!ok) throw new Error('تعذّر تسليم تنبيه المدير عبر أي قناة');
        } else {
          await notifyHuman(
            String(payload.contactKey ?? ''),
            String(payload.name ?? ''),
            String(payload.lastMessage ?? note),
            payload.reason ? String(payload.reason) : undefined,
          );
        }
        return;
      }
      case 'booking_reminder':
      case 'customer_message': {
        const key = String(payload.key ?? '');
        const text = String(payload.text ?? '');
        if (!key || !text) throw new Error('إشعار عميل ناقص المفتاح/النص');
        const res = await sendOutbound(key, text);
        if (!res.ok) throw new Error(res.error ?? 'فشل الإرسال للعميل');
        return;
      }
      default:
        log.warn(`نوع إشعار غير معروف: ${n.kind} — يُعتبَر مُسلَّمًا لمنع الدوران`);
    }
  }
}

export const notifications = new NotificationService();
