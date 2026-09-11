/** مستودع المحادثات والرسائل — يواكب مخزن الجلسات الحي في قاعدة البيانات */
import { all, get, run } from '../client.js';
import type { ConversationRow } from '../types.js';
import { parseContactKey, upsertUser } from './users.js';

export type ConversationState = 'bot' | 'human' | 'paused';
export type MessageDirection = 'in' | 'out' | 'system';

export interface MessageInsert {
  externalId?: string | null;
  dir: MessageDirection;
  type?: string;
  body: string;
  caption?: string | null;
  tool?: string | null;
  meta?: Record<string, unknown>;
  createdAt?: number;
}

/** جلب المحادثة أو إنشاؤها (مع جلب/إنشاء المستخدم) */
export function ensureConversation(contactKey: string, displayName = ''): ConversationRow {
  const { channel } = parseContactKey(contactKey);
  const user = upsertUser(contactKey, displayName ? { displayName } : {});
  let conv = get<ConversationRow>('SELECT * FROM conversations WHERE contact_key = ?', [contactKey]);
  if (!conv) {
    const now = Date.now();
    run(
      `INSERT INTO conversations (user_id, channel, contact_key, display_name, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'bot', ?, ?)`,
      [user.id, channel, contactKey, displayName || user.display_name || contactKey, now, now],
    );
    conv = get<ConversationRow>('SELECT * FROM conversations WHERE contact_key = ?', [contactKey])!;
  } else if (displayName && displayName !== conv.display_name) {
    run('UPDATE conversations SET display_name = ?, updated_at = ? WHERE id = ?', [displayName, Date.now(), conv.id]);
    conv.display_name = displayName;
  }
  return conv;
}

/**
 * تسجيل رسالة مع منع تكرار على external_id (طبقة ثانية بعد ذاكرة المنسّق).
 * يرجع false إذا كانت الرسالة مسجّلة من قبل (تحديث مكرر من القناة).
 */
export function insertMessage(contactKey: string, msg: MessageInsert): boolean {
  const conv = ensureConversation(contactKey);
  const ts = msg.createdAt ?? Date.now();
  if (msg.externalId) {
    const dup = get<{ id: number }>('SELECT id FROM messages WHERE external_id = ?', [msg.externalId]);
    if (dup) return false;
  }
  run(
    `INSERT INTO messages (conversation_id, external_id, dir, type, body, caption, tool, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      conv.id, msg.externalId ?? null, msg.dir, msg.type ?? 'text', msg.body,
      msg.caption ?? null, msg.tool ?? null, JSON.stringify(msg.meta ?? {}), ts,
    ],
  );
  if (msg.dir === 'in') run('UPDATE conversations SET last_inbound_at = ?, updated_at = ? WHERE id = ?', [ts, ts, conv.id]);
  if (msg.dir === 'out') run('UPDATE conversations SET last_outbound_at = ?, updated_at = ? WHERE id = ?', [ts, ts, conv.id]);
  return true;
}

export function setConversationState(
  contactKey: string,
  state: ConversationState,
  opts: { reason?: string | null; assignedAdminId?: number | null } = {},
): void {
  const conv = ensureConversation(contactKey);
  run(
    `UPDATE conversations SET state = ?, handoff_reason = COALESCE(?, handoff_reason),
       assigned_admin_id = COALESCE(?, assigned_admin_id), updated_at = ? WHERE id = ?`,
    [state, opts.reason ?? null, opts.assignedAdminId ?? null, Date.now(), conv.id],
  );
}

export function setConversationSummary(contactKey: string, summary: string): void {
  const conv = ensureConversation(contactKey);
  run('UPDATE conversations SET summary = ?, updated_at = ? WHERE id = ?', [summary, Date.now(), conv.id]);
}

export function listConversations(limit = 100): ConversationRow[] {
  return all<ConversationRow>('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?', [limit]);
}

export function listConversationMessages(contactKey: string, limit = 50) {
  const conv = get<ConversationRow>('SELECT * FROM conversations WHERE contact_key = ?', [contactKey]);
  if (!conv) return [];
  return all<{ dir: MessageDirection; body: string; type: string; created_at: number }>(
    'SELECT dir, body, type, created_at FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?',
    [conv.id, limit],
  ).reverse();
}
