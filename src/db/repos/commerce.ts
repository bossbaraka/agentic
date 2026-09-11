/** مستودع الطلبات والمدفوعات وتذاكر الدعم */
import { all, get, run, transaction } from '../client.js';
import type { OrderRow, ServiceRow, TicketRow } from '../types.js';

function refCode(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

// ───────────────────────── الطلبات ─────────────────────────

export interface CreateOrderInput {
  contactKey: string;
  kind?: OrderRow['kind'];
  service?: ServiceRow | null;
  summary: string;
  status?: OrderRow['status'];
  totalAmount?: number | null;
  payload?: Record<string, unknown>;
  userId?: number | null;
  customerId?: number | null;
  idempotencyKey?: string | null;
  ref?: string;
}

export function createOrder(input: CreateOrderInput): OrderRow {
  return transaction(() => {
    if (input.idempotencyKey) {
      const dup = get<OrderRow>('SELECT * FROM orders WHERE idempotency_key = ?', [input.idempotencyKey]);
      if (dup) return dup;
    }
    const ref = input.ref?.trim() ? input.ref.trim().toUpperCase() : refCode('ORD');
    const now = Date.now();
    const r = run(
      `INSERT INTO orders
        (ref, idempotency_key, kind, customer_id, user_id, service_id, contact_key, summary,
         status, total_amount, currency, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ILS', ?, ?, ?)`,
      [
        ref, input.idempotencyKey ?? null, input.kind ?? 'launch', input.customerId ?? null,
        input.userId ?? null, input.service?.id ?? null, input.contactKey, input.summary,
        input.status ?? 'PENDING', input.totalAmount ?? null,
        JSON.stringify(input.payload ?? {}), now, now,
      ],
    );
    return get<OrderRow>('SELECT * FROM orders WHERE id = ?', [r.lastInsertRowid])!;
  });
}

export function getOrderByRef(ref: string): OrderRow | undefined {
  return get<OrderRow>('SELECT * FROM orders WHERE UPPER(ref) = UPPER(?)', [ref.trim()]);
}

export function listOrdersForContact(contactKey: string, limit = 10): OrderRow[] {
  return all<OrderRow>(
    'SELECT * FROM orders WHERE contact_key = ? ORDER BY created_at DESC LIMIT ?',
    [contactKey, limit],
  );
}

export function listOrdersAdmin(opts: { status?: string; limit?: number; offset?: number } = {}): { rows: OrderRow[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.status && opts.status !== 'all') { where.push('status = ?'); params.push(opts.status); }
  const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(get<{ n: number }>(`SELECT COUNT(*) AS n FROM orders ${sql}`, params)?.n ?? 0);
  const rows = all<OrderRow>(
    `SELECT * FROM orders ${sql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, opts.limit ?? 10, opts.offset ?? 0],
  );
  return { rows, total };
}

export function setOrderStatus(ref: string, status: OrderRow['status']): OrderRow | undefined {
  run('UPDATE orders SET status = ?, updated_at = ? WHERE UPPER(ref) = UPPER(?)', [status, Date.now(), ref]);
  return getOrderByRef(ref);
}

// ───────────────────────── التذاكر ─────────────────────────

export interface CreateTicketInput {
  contactKey: string;
  restaurantName?: string | null;
  plan?: string | null;
  issue: string;
  priority?: TicketRow['priority'];
  userId?: number | null;
  customerId?: number | null;
  conversationId?: number | null;
}

export function createTicket(input: CreateTicketInput): TicketRow {
  return transaction(() => {
    const ref = refCode('TCK');
    const now = Date.now();
    const r = run(
      `INSERT INTO support_tickets
        (ref, customer_id, user_id, conversation_id, contact_key, restaurant_name, plan, issue,
         priority, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)`,
      [
        ref, input.customerId ?? null, input.userId ?? null, input.conversationId ?? null,
        input.contactKey, input.restaurantName ?? null, input.plan ?? null, input.issue,
        input.priority ?? 'normal', now, now,
      ],
    );
    return get<TicketRow>('SELECT * FROM support_tickets WHERE id = ?', [r.lastInsertRowid])!;
  });
}

export function getTicketByRef(ref: string): TicketRow | undefined {
  return get<TicketRow>('SELECT * FROM support_tickets WHERE UPPER(ref) = UPPER(?)', [ref.trim()]);
}

export function listTicketsForContact(contactKey: string): TicketRow[] {
  return all<TicketRow>(
    'SELECT * FROM support_tickets WHERE contact_key = ? ORDER BY created_at DESC',
    [contactKey],
  );
}

export function listTicketsAdmin(opts: { status?: string; limit?: number; offset?: number } = {}): { rows: TicketRow[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.status && opts.status !== 'all') { where.push('status = ?'); params.push(opts.status); }
  const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(get<{ n: number }>(`SELECT COUNT(*) AS n FROM support_tickets ${sql}`, params)?.n ?? 0);
  const rows = all<TicketRow>(
    `SELECT * FROM support_tickets ${sql} ORDER BY
       CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
       created_at DESC LIMIT ? OFFSET ?`,
    [...params, opts.limit ?? 10, opts.offset ?? 0],
  );
  return { rows, total };
}

export function setTicketStatus(ref: string, status: TicketRow['status'], resolution?: string): TicketRow | undefined {
  run(
    'UPDATE support_tickets SET status = ?, resolution = COALESCE(?, resolution), updated_at = ? WHERE UPPER(ref) = UPPER(?)',
    [status, resolution ?? null, Date.now(), ref],
  );
  return getTicketByRef(ref);
}
