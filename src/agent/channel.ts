import { config } from '../config.js';
import { log } from '../lib/utils.js';
import type { MediaPart } from '../types.js';
import { fetchInboundMedia } from '../whatsapp/media.js';
import {
  markReadAndTyping as markWaReadAndTyping,
  notifyHumanAgent as notifyWaHumanAgent,
  sendReaction as sendWaReaction,
  sendText as sendWaText,
  sendLongText as sendWaLongText,
} from '../whatsapp/outgoing.js';
import {
  fetchTelegramMedia,
  sendTelegramLongText,
  sendTelegramText,
  sendTelegramTyping,
} from '../telegram/outgoing.js';

/** هل المعرّف خاص بـ Telegram؟ */
export function isTelegramChannel(key: string): boolean {
  return key.startsWith('tg:');
}

/** تعليم كمقروء ومؤشر الكتابة حسب القناة */
export async function dispatchMarkReadAndTyping(key: string, messageId: string, phoneNumberId?: string): Promise<void> {
  if (isTelegramChannel(key)) {
    await sendTelegramTyping(key);
  } else {
    await markWaReadAndTyping(messageId, phoneNumberId);
  }
}

/** تفاعل إيموجي (Reactions) */
export async function dispatchSendReaction(key: string, messageId: string, emoji: string, phoneNumberId?: string): Promise<void> {
  if (isTelegramChannel(key)) {
    // تليجرام لا يتطلب التفاعل الفوري إلزاميًا
    return;
  }
  await sendWaReaction(key, messageId, emoji, phoneNumberId);
}

/** إرسال نص عادي حسب القناة */
export async function dispatchSendText(
  key: string,
  body: string,
  opts: { phoneNumberId?: string; previewUrl?: boolean; contextMessageId?: string } = {},
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  if (isTelegramChannel(key)) {
    return sendTelegramText(key, body);
  }
  return sendWaText(key, body, opts);
}

/** إرسال نص طويل مقسّم حسب القناة */
export async function dispatchSendLongText(
  key: string,
  text: string,
  opts: { phoneNumberId?: string; contextMessageId?: string; pauseMs?: number } = {},
): Promise<{ ok: boolean; messageIds: string[]; parts: number }> {
  if (isTelegramChannel(key)) {
    return sendTelegramLongText(key, text);
  }
  return sendWaLongText(key, text, opts);
}

/** تنزيل وسائط حسب القناة */
export async function dispatchFetchMedia(
  key: string,
  mediaId: string,
  kind: MediaPart['kind'],
  mimeType: string,
): Promise<MediaPart | null> {
  if (isTelegramChannel(key)) {
    return fetchTelegramMedia(mediaId, kind, mimeType);
  }
  return fetchInboundMedia({ id: mediaId, mimeType, kind });
}

/** إرسال تنبيه للموظف البشري */
export async function dispatchNotifyHumanAgent(
  sessionKey: string,
  customerName: string,
  lastMessage: string,
  reason?: string,
): Promise<void> {
  const agentId = config.whatsapp.HUMAN_AGENT_ID;
  if (!agentId) return;

  const note =
    `🚨 **طلب تحويل لبشري!**\n` +
    `العميل: ${customerName} (${sessionKey})\n` +
    (reason ? `السبب: ${reason}\n` : '') +
    `آخر رسالة: ${lastMessage.slice(0, 300)}`;

  if (isTelegramChannel(agentId)) {
    await sendTelegramText(agentId, note);
  } else {
    await notifyWaHumanAgent(sessionKey, customerName, lastMessage, reason);
  }
}
