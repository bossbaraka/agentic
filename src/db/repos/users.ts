/** مستودع المستخدمين والعملاء والمشرفين */
import { all, get, run, transaction } from '../client.js';
import type { AdminRow, CustomerRow, Lang, Role, UserRow } from '../types.js';

export function parseContactKey(key: string): { channel: 'tg' | 'wa'; channelUserId: string } {
  if (key.startsWith('tg:')) return { channel: 'tg', channelUserId: key.slice(3) };
  return { channel: 'wa', channelUserId: key };
}

export interface UserUpsert {
  displayName?: string | null;
  username?: string | null;
  phone?: string | null;
  language?: Lang;
}

/** إنشاء/تحديث مستخدم من مفتاح الجلسة الموحّد — يرجع صف المستخدم */
export function upsertUser(contactKey: string, info: UserUpsert = {}): UserRow {
  const { channel, channelUserId } = parseContactKey(contactKey);
  const now = Date.now();

  return transaction(() => {
    const existing = get<UserRow>('SELECT * FROM users WHERE channel = ? AND channel_user_id = ?', [channel, channelUserId]);
    if (existing) {
      run(
        `UPDATE users SET
           display_name = COALESCE(?, display_name),
           username = COALESCE(?, username),
           phone = COALESCE(?, phone),
           language = COALESCE(?, language),
           updated_at = ?, last_seen_at = ?
         WHERE id = ?`,
        [info.displayName ?? null, info.username ?? null, info.phone ?? null, info.language ?? null, now, now, existing.id],
      );
      return { ...existing,
        display_name: info.displayName ?? existing.display_name,
        username: info.username ?? existing.username,
        phone: info.phone ?? existing.phone,
        language: info.language ?? existing.language,
        updated_at: now, last_seen_at: now };
    }
    const r = run(
      `INSERT INTO users (channel, channel_user_id, username, display_name, phone, language, created_at, updated_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [channel, channelUserId, info.username ?? null, info.displayName ?? null, info.phone ?? null, info.language ?? 'ar', now, now, now],
    );
    return get<UserRow>('SELECT * FROM users WHERE id = ?', [r.lastInsertRowid])!;
  });
}

export function getUserByContact(contactKey: string): UserRow | undefined {
  const { channel, channelUserId } = parseContactKey(contactKey);
  return get<UserRow>('SELECT * FROM users WHERE channel = ? AND channel_user_id = ?', [channel, channelUserId]);
}

export function setUserLanguage(contactKey: string, language: Lang): void {
  const u = upsertUser(contactKey, { language });
  run('UPDATE users SET language = ? WHERE id = ?', [language, u.id]);
}

export function userLanguage(contactKey: string): Lang {
  return getUserByContact(contactKey)?.language ?? 'ar';
}

// ───────────────────────── العملاء (ملف النشاط التجاري) ─────────────────────────

export interface CustomerPatch {
  fullName?: string;
  restaurantName?: string;
  city?: string;
  tables?: number;
  branches?: number;
  preferredPlan?: string;
  notes?: string;
}

/** جلب ملف العميل المرتبط بمستخدم أو إنشاؤه */
export function ensureCustomer(contactKey: string, info: UserUpsert = {}): { user: UserRow; customer: CustomerRow } {
  const user = upsertUser(contactKey, info);
  let customer = get<CustomerRow>('SELECT * FROM customers WHERE user_id = ?', [user.id]);
  if (!customer) {
    const now = Date.now();
    run(
      `INSERT INTO customers (user_id, code, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
      [user.id, `CUS-${String(user.id).padStart(5, '0')}`, now, now],
    );
    customer = get<CustomerRow>('SELECT * FROM customers WHERE user_id = ?', [user.id])!;
  }
  return { user, customer };
}

export function patchCustomer(contactKey: string, patch: CustomerPatch): CustomerRow | undefined {
  const { customer } = ensureCustomer(contactKey);
  run(
    `UPDATE customers SET
       full_name = COALESCE(?, full_name),
       restaurant_name = COALESCE(?, restaurant_name),
       city = COALESCE(?, city),
       tables = COALESCE(?, tables),
       branches = COALESCE(?, branches),
       preferred_plan = COALESCE(?, preferred_plan),
       notes = COALESCE(?, notes),
       updated_at = ?
     WHERE id = ?`,
    [
      patch.fullName ?? null, patch.restaurantName ?? null, patch.city ?? null,
      patch.tables ?? null, patch.branches ?? null, patch.preferredPlan ?? null,
      patch.notes ?? null, Date.now(), customer.id,
    ],
  );
  return get<CustomerRow>('SELECT * FROM customers WHERE id = ?', [customer.id]);
}

export function listCustomers(limit = 50): (CustomerRow & { contact_key: string; language: Lang })[] {
  return all(`
    SELECT c.*, (u.channel || ':' || u.channel_user_id) AS contact_key, u.language
    FROM customers c JOIN users u ON u.id = c.user_id
    ORDER BY c.updated_at DESC LIMIT ?`, [limit]);
}

// ───────────────────────── المشرفون (RBAC) ─────────────────────────

export function getAdminByTelegramId(telegramId: string): AdminRow | undefined {
  return get<AdminRow>('SELECT * FROM admins WHERE telegram_id = ? AND is_active = 1', [String(telegramId)]);
}

export function listAdmins(includeInactive = false): AdminRow[] {
  return all<AdminRow>(
    `SELECT * FROM admins ${includeInactive ? '' : 'WHERE is_active = 1'} ORDER BY role, id`,
  );
}

export function addAdmin(input: {
  telegramId: string;
  role: Role;
  username?: string | null;
  displayName?: string | null;
  createdBy?: number | null;
}): { created: boolean; admin: AdminRow } {
  const existing = get<AdminRow>('SELECT * FROM admins WHERE telegram_id = ?', [input.telegramId]);
  const now = Date.now();
  if (existing) {
    run('UPDATE admins SET role = ?, is_active = 1, username = COALESCE(?, username), display_name = COALESCE(?, display_name), updated_at = ? WHERE id = ?',
      [input.role, input.username ?? null, input.displayName ?? null, now, existing.id]);
    return { created: false, admin: get<AdminRow>('SELECT * FROM admins WHERE id = ?', [existing.id])! };
  }
  run(
    `INSERT INTO admins (telegram_id, username, display_name, role, is_active, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
    [input.telegramId, input.username ?? null, input.displayName ?? null, input.role, input.createdBy ?? null, now, now],
  );
  const admin = get<AdminRow>('SELECT * FROM admins WHERE telegram_id = ?', [input.telegramId])!;
  return { created: true, admin };
}

export function setAdminActive(id: number, active: boolean): void {
  run('UPDATE admins SET is_active = ?, updated_at = ? WHERE id = ?', [active ? 1 : 0, Date.now(), id]);
}

export function countUsers(): number {
  return Number(get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0);
}
