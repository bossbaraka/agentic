/**
 * موزّع تحديثات تيليجرام — نقطة قرار واحدة:
 *   1. أوامر/أزرار الإدارة (RBAC) → TelegramAdminHandler
 *   2. قوائم النظام (تنقل/حجز/طلب)   → TelegramMenuRouter
 *   3. أي شيء آخر (نص حر/وسائط/أزرار AI) → AgentOrchestrator
 *
 * بهذا لا تحتوي Handlers على منطق أعمال، والعمليات الحساسة لا تمر بالنموذج.
 */
import { log } from '../lib/utils.js';
import { orchestrator } from '../agent/agent.js';
import { bridge } from '../services/conversationBridge.js';
import { parseTelegramUpdate } from './incoming.js';
import { tgAnswerCallback } from './client.js';
import { menuRouter } from './router.js';
import { TelegramAdminHandler } from './admin.js';

export const adminHandler = new TelegramAdminHandler();

function callbackContext(raw: any) {
  const cq = raw?.callback_query;
  if (!cq) return null;
  const chatId = String(cq.message?.chat?.id ?? cq.from?.id ?? '');
  return {
    id: String(cq.id ?? ''),
    fromId: String(cq.from?.id ?? ''),
    chatId,
    messageId: String(cq.message?.message_id ?? ''),
    data: String(cq.data ?? ''),
  };
}

/** معالجة تحديث خام قادم من polling أو webhook */
export async function dispatchTelegramUpdate(raw: any): Promise<void> {
  try {
    // ───── أزرار Inline ─────
    if (raw?.callback_query) {
      const ctx = callbackContext(raw);
      if (!ctx) return;

      if (ctx.data.startsWith('a:')) {
        const result = await adminHandler.handleCallback(ctx);
        await tgAnswerCallback(ctx.id, result?.alert ? { text: result.alert, alert: result.popup } : {});
        return;
      }

      const result = await menuRouter.handleCallback(ctx);
      if (!result?.unhandled) {
        await tgAnswerCallback(ctx.id, result?.alert ? { text: result.alert, alert: result.popup } : {});
        return;
      }
      // زر ذكاء سريع (qr:...) أو غير معروف → مرّره كرسالة للمنسّق
      await tgAnswerCallback(ctx.id);
      const msg = parseTelegramUpdate(raw);
      if (msg) await orchestrator.handleInbound(msg);
      return;
    }

    // ───── رسائل عادية ─────
    const msg = parseTelegramUpdate(raw);
    if (!msg) return;

    // 1) أوامر إدارية للمشرفين فقط
    if (/^\//.test(msg.body) && (await adminHandler.handleText(msg))) {
      bridge.inbound(msg);
      return;
    }

    // 2) قوائم النظام (/start، /menu، أزرار اللوحة الدائمة)
    if (await menuRouter.handleText(msg)) {
      bridge.inbound(msg);
      return;
    }

    // 3) النص الحر والوسائط → الذكاء الاصطناعي
    await orchestrator.handleInbound(msg);
  } catch (err) {
    log.error(`خطأ في موزّع تيليجرام: ${(err as Error).stack ?? err}`);
  }
}
