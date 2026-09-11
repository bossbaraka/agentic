/**
 * استيراد لمرة واحدة من مخزن JSON القديم (data/sessions.json) إلى قاعدة
 * البيانات العلائقية.
 *
 * التصميم:
 *  • آمن لإعادة التشغيل (idempotent): رسائل legacy لها external_id مميّز،
 *    وطلبات الإطلاق لها idempotency_key — التكرار يتجاهل الصفوف القديمة.
 *  • دفاعي تمامًا: ملف غير موجود أو تالف لا يُفشل الإقلاع.
 *  • يقرأ فقط؛ لا يحذف ملفات JSON الأصلية.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../lib/utils.js';
import { upsertUser, patchCustomer } from './repos/users.js';
import { ensureConversation, insertMessage, setConversationState } from './repos/conversations.js';
import { createOrder } from './repos/commerce.js';
import { get } from './client.js';
import type { Session, ConversationState } from '../types.js';
import type { OrderRow } from './types.js';

interface ImportCounts {
  sessions: number;
  messages: number;
  customers: number;
  orders: number;
}

export function importLegacyState(file?: string): ImportCounts {
  const filep = file ?? path.join(config.paths.DATA_DIR, 'sessions.json');
  const counts: ImportCounts = { sessions: 0, messages: 0, customers: 0, orders: 0 };
  if (!fs.existsSync(filep)) return counts;

  let sessions: Session[];
  try {
    sessions = JSON.parse(fs.readFileSync(filep, 'utf8')) as Session[];
  } catch (err) {
    log.warn(`legacyImport: تعذّر قراءة ${filep}: ${(err as Error).message}`);
    return counts;
  }
  if (!Array.isArray(sessions)) return counts;

  for (const s of sessions) {
    try {
      counts.sessions++;
      const language = (['ar', 'en', 'he'].includes(s.language) ? s.language : 'ar') as 'ar' | 'en' | 'he';
      upsertUser(s.key, { displayName: s.name || null, language });
      ensureConversation(s.key, s.name);
      if (s.state && s.state !== 'bot') {
        setConversationState(s.key, s.state as ConversationState, { reason: 'مستورد من المخزن القديم' });
      }

      // ملف النشاط التجاري
      const p = s.profile;
      if (p && (p.restaurant_name || p.full_name)) {
        patchCustomer(s.key, {
          fullName: p.full_name,
          restaurantName: p.restaurant_name,
          city: p.city,
          tables: p.tables,
          branches: p.branches,
          preferredPlan: p.preferred_plan,
          notes: p.notes,
        });
        counts.customers++;
      }

      // الرسائل
      for (const m of s.messages ?? []) {
        const inserted = insertMessage(s.key, {
          externalId: `legacy:${m.id}`,
          dir: m.dir,
          type: m.type,
          body: m.body ?? '',
          caption: m.caption ?? null,
          createdAt: m.createdAt,
          meta: { legacy: true, ...(m.meta ?? {}) },
        });
        if (inserted) counts.messages++;
      }

      // طلب إطلاق مؤكد قديم (نتخطّى لو سبق استيراده — idempotent)
      if (s.launch?.status === 'confirmed') {
        const idem = `legacy-launch:${s.key}`;
        const existed = get<OrderRow>('SELECT 1 AS x FROM orders WHERE idempotency_key = ?', [idem]);
        if (!existed) {
          createOrder({
            contactKey: s.key,
            kind: 'launch',
            summary: s.launch.blueprint ? `طلب إطلاق مستورد:\n${s.launch.blueprint.slice(0, 500)}` : 'طلب إطلاق مستورد من النظام القديم',
            status: 'CONFIRMED',
            payload: { legacy: true, plan: s.profile?.preferred_plan ?? null },
            idempotencyKey: idem,
          });
          counts.orders++;
        }
      }
    } catch (err) {
      log.warn(`legacyImport: تخطّي ${s.key}: ${(err as Error).message}`);
    }
  }

  if (counts.sessions) {
    log.ok(`📦 استيراد legacy: ${counts.sessions} جلسة، ${counts.messages} رسالة، ${counts.customers} عميل، ${counts.orders} طلب`);
  }
  return counts;
}
