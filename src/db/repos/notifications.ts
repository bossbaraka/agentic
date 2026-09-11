/** مستودع طابور الإشعارات */
import { all, get, run } from '../client.js';
import type { NotificationRow } from '../types.js';

export type NotificationStatus = NotificationRow['status'];

export interface EnqueueInput {
  kind: string;
  /** tg | wa — أو null ليقرر العامل القناة من المفتاح */
  channel?: 'tg' | 'wa' | null;
  targetKey?: string | null;
  subject?: string;
  payload: Record<string, unknown>;
  /** متى يُرسل (epoch) — الافتراضي فورًا */
  runAt?: number;
  maxAttempts?: number;
}

export function enqueueNotification(input: EnqueueInput): number {
  const now = Date.now();
  const r = run(
    `INSERT INTO notifications
      (kind, channel, target_key, subject, payload, status, attempts, max_attempts, run_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'PENDING', 0, ?, ?, ?, ?)`,
    [
      input.kind, input.channel ?? null, input.targetKey ?? null, input.subject ?? '',
      JSON.stringify(input.payload ?? {}), input.maxAttempts ?? 5, input.runAt ?? now, now, now,
    ],
  );
  return r.lastInsertRowid;
}

/** إشعارات مستحقة قيد الانتظار — تُعلَّم PROCESSING داخل نداء العامل */
export function dueNotifications(limit = 10): NotificationRow[] {
  const now = Date.now();
  return all<NotificationRow>(
    `SELECT * FROM notifications WHERE status = 'PENDING' AND run_at <= ? ORDER BY run_at ASC, id ASC LIMIT ?`,
    [now, limit],
  );
}

export function markProcessing(id: number): void {
  run(`UPDATE notifications SET status = 'PROCESSING', attempts = attempts + 1, updated_at = ? WHERE id = ?`,
    [Date.now(), id]);
}

export function markSent(id: number): void {
  run(`UPDATE notifications SET status = 'SENT', last_error = NULL, updated_at = ? WHERE id = ?`, [Date.now(), id]);
}

export function markFailed(id: number, error: string, retryAt?: number): void {
  const n = get<NotificationRow>('SELECT * FROM notifications WHERE id = ?', [id]);
  const attempts = Number(n?.attempts ?? 1);
  const max = Number(n?.max_attempts ?? 5);
  if (attempts >= max) {
    run(`UPDATE notifications SET status = 'FAILED', last_error = ?, updated_at = ? WHERE id = ?`,
      [error.slice(500), Date.now(), id]);
  } else {
    run(`UPDATE notifications SET status = 'PENDING', last_error = ?, run_at = ?, updated_at = ? WHERE id = ?`,
      [error.slice(500), retryAt ?? Date.now() + backoffMs(attempts), Date.now(), id]);
  }
}

export function cancelNotifications(predicate: { kind?: string; targetKey?: string }): number {
  const where: string[] = ["status IN ('PENDING','PROCESSING')"];
  const params: unknown[] = [];
  if (predicate.kind) { where.push('kind = ?'); params.push(predicate.kind); }
  if (predicate.targetKey) { where.push('target_key = ?'); params.push(predicate.targetKey); }
  const r = run(`UPDATE notifications SET status = 'CANCELLED', updated_at = ? WHERE ${where.join(' AND ')}`,
    [Date.now(), ...params]);
  return r.changes;
}

/** تراجع أُسي: 30s، دقيقة، دقيقتان، 4 دقائق... */
function backoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 5 * 60_000);
}

export function notificationCounts(): Record<string, number> {
  const rows = all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM notifications GROUP BY status');
  const out: Record<string, number> = { PENDING: 0, PROCESSING: 0, SENT: 0, FAILED: 0, CANCELLED: 0 };
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

export function pendingCount(): number {
  return Number(get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE status = 'PENDING'")?.n ?? 0);
}
