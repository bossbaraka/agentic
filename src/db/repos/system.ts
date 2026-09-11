/** سجل التدقيق (Audit) وأحداث القياسات (Metrics) */
import { all, get, run } from '../client.js';

// ───────────────────────── سجل التدقيق ─────────────────────────

export interface AuditEntry {
  actorType?: 'customer' | 'admin' | 'system' | 'llm';
  actorId?: string | null;
  action: string;
  entity?: string | null;
  entityId?: string | null;
  meta?: Record<string, unknown>;
  ip?: string | null;
}

export function audit(entry: AuditEntry): void {
  try {
    run(
      `INSERT INTO audit_logs (actor_type, actor_id, action, entity, entity_id, meta, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.actorType ?? 'system', entry.actorId ?? null, entry.action,
        entry.entity ?? null, entry.entityId ?? null,
        JSON.stringify(entry.meta ?? {}), entry.ip ?? null, Date.now(),
      ],
    );
  } catch {
    /* التدقيق لا يكسر مسار العمل أبدًا */
  }
}

export function listAudit(opts: { limit?: number; entity?: string; actorId?: string } = {}): Record<string, unknown>[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.entity) { where.push('entity = ?'); params.push(opts.entity); }
  if (opts.actorId) { where.push('actor_id = ?'); params.push(opts.actorId); }
  const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return all(
    `SELECT id, actor_type, actor_id, action, entity, entity_id, meta, ip, created_at
     FROM audit_logs ${sql} ORDER BY id DESC LIMIT ?`,
    [...params, opts.limit ?? 30],
  );
}

// ───────────────────────── القياسات ─────────────────────────

export function recordMetric(type: string, opts: { refKey?: string | null; value?: number; meta?: Record<string, unknown> } = {}): void {
  try {
    run(
      'INSERT INTO metric_events (type, ref_key, value, meta, created_at) VALUES (?, ?, ?, ?, ?)',
      [type, opts.refKey ?? null, opts.value ?? 1, JSON.stringify(opts.meta ?? {}), Date.now()],
    );
  } catch { /* القياس لا يكسر العمل */ }
}

function countSince(type: string, sinceMs: number): number {
  return Number(
    get<{ n: number }>('SELECT COUNT(*) AS n FROM metric_events WHERE type = ? AND created_at >= ?', [type, sinceMs])?.n ?? 0,
  );
}

export interface MetricsSummary {
  users: number;
  conversations: number;
  orders: number;
  bookings: Record<string, number>;
  ticketsOpen: number;
  handoffs: number;
  inbound24h: number;
  outbound24h: number;
  conversionRate: number;
  avgResponseMs: number;
  topServices: { slug: string | null; name: string; count: number }[];
  bookingCancellationRate: number;
}

export function metricsSummary(): MetricsSummary {
  const dayAgo = Date.now() - 86_400_000;
  const users = Number(get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0);
  const conversations = Number(get<{ n: number }>('SELECT COUNT(*) AS n FROM conversations')?.n ?? 0);
  const orders = Number(get<{ n: number }>('SELECT COUNT(*) AS n FROM orders')?.n ?? 0);
  const ticketsOpen = Number(
    get<{ n: number }>("SELECT COUNT(*) AS n FROM support_tickets WHERE status IN ('OPEN','IN_PROGRESS')")?.n ?? 0,
  );
  const bookingsRows = all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM bookings GROUP BY status');
  const bookings: Record<string, number> = { PENDING: 0, CONFIRMED: 0, COMPLETED: 0, CANCELLED: 0, NO_SHOW: 0 };
  for (const r of bookingsRows) bookings[r.status] = Number(r.n);
  const bookingTotal = Object.values(bookings).reduce((a, b) => a + b, 0);

  const topServices = all<{ slug: string | null; count: number }>(
    `SELECT s.slug AS slug, COUNT(b.id) AS count
     FROM bookings b LEFT JOIN services s ON s.id = b.service_id
     GROUP BY b.service_id ORDER BY count DESC LIMIT 5`,
  ).map((r) => ({ slug: r.slug, name: r.slug ?? 'غير محدد', count: Number(r.count) }));

  const latency = get<{ avg: number }>(
    "SELECT AVG(value) AS avg FROM metric_events WHERE type = 'llm_latency_ms'",
  );
  const usersWithOrders = Number(get<{ n: number }>('SELECT COUNT(DISTINCT contact_key) AS n FROM orders')?.n ?? 0);

  return {
    users,
    conversations,
    orders,
    bookings,
    ticketsOpen,
    handoffs: countSince('handoff', 0),
    inbound24h: countSince('inbound', dayAgo),
    outbound24h: countSince('outbound', dayAgo),
    conversionRate: users > 0 ? Math.round((usersWithOrders / users) * 1000) / 10 : 0,
    avgResponseMs: Math.round(Number(latency?.avg ?? 0)),
    topServices,
    bookingCancellationRate: bookingTotal > 0 ? Math.round((bookings.CANCELLED / bookingTotal) * 1000) / 10 : 0,
  };
}
