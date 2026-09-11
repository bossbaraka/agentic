/**
 * جسر المزامنة: ينسخ المستخدمين/المحادثات/الرسائل من مسار المعالجة الحي
 * إلى قاعدة البيانات العلائقية دون أن يغيّر سلوك مخزن الجلسات JSON القائم.
 * كل الدوال دفاعية (لا ترمي خطأ يكسر مسار الرسالة).
 */
import { log } from '../lib/utils.js';
import { upsertUser, patchCustomer, type CustomerPatch } from '../db/repos/users.js';
import {
  ensureConversation,
  insertMessage,
  setConversationState,
  setConversationSummary,
  type ConversationState,
} from '../db/repos/conversations.js';
import { recordMetric } from '../db/repos/system.js';
import type { NormalizedInbound } from '../whatsapp/types.js';
import type { WaMessageType } from '../types.js';

function safe<T>(fn: () => T, label: string): T | undefined {
  try { return fn(); } catch (err) {
    log.warn(`conversationBridge: ${label} — ${(err as Error).message}`);
    return undefined;
  }
}

export const bridge = {
  /** مزامنة رسالة واردة (والمستخدم/المحادثة) — يرجع false لو كانت مكررة */
  inbound(msg: NormalizedInbound): boolean {
    return safe(() => {
      const body = msg.body ?? '';
      const lang = /^[a-zA-Z\s.,!?'"0-9-]+$/.test(body.trim()) && body.trim().length > 3
        ? ('en' as const)
        : ('ar' as const);
      upsertUser(msg.from, {
        displayName: msg.contactName,
        username: msg.telegramUsername ?? null,
        language: lang,
      });
      ensureConversation(msg.from, msg.contactName);
      const inserted = insertMessage(msg.from, {
        externalId: msg.waId,
        dir: 'in',
        type: msg.type,
        body: msg.body ?? '',
        caption: msg.caption ?? null,
        createdAt: msg.timestamp || Date.now(),
        meta: { forwarded: msg.forwarded, reply: msg.reply?.title },
      });
      if (inserted) recordMetric('inbound', { refKey: msg.from });
      return inserted;
    }, 'inbound') ?? true;
  },

  /** مزامنة رسالة صادرة (نص أو جزء وسائط) */
  outbound(
    contactKey: string,
    part: string | { type: WaMessageType; body?: string; caption?: string; mediaId?: string; mime?: string; fileSize?: number; name?: string; url?: string },
    opts: { externalId?: string; tool?: string; meta?: Record<string, unknown> } = {},
  ): void {
    safe(() => {
      ensureConversation(contactKey);
      const isStr = typeof part === 'string';
      insertMessage(contactKey, {
        externalId: opts.externalId,
        dir: 'out',
        type: isStr ? 'text' : part.type,
        body: isStr ? part : (part.body ?? part.caption ?? ''),
        caption: isStr ? null : (part.caption ?? null),
        tool: opts.tool ?? null,
        meta: opts.meta ?? (isStr ? {} : { mediaId: part.mediaId, mime: part.mime, name: part.name, url: part.url }),
      });
      recordMetric('outbound', { refKey: contactKey });
    }, 'outbound');
  },

  /** تحديث اللغة المكتشفة/المختارة للمستخدم في قاعدة البيانات */
  setLanguage(contactKey: string, language: 'ar' | 'en' | 'he'): void {
    safe(() => upsertUser(contactKey, { language }), 'setLanguage');
  },

  patchCustomer(contactKey: string, patch: CustomerPatch): void {
    safe(() => patchCustomer(contactKey, patch), 'patchCustomer');
  },

  setState(contactKey: string, state: ConversationState, reason?: string | null, assignedAdminId?: number | null): void {
    safe(() => setConversationState(contactKey, state, { reason: reason ?? null, assignedAdminId: assignedAdminId ?? null }), 'setState');
  },

  setSummary(contactKey: string, summary: string): void {
    safe(() => setConversationSummary(contactKey, summary), 'setSummary');
  },
};
