import { config } from '../config.js';
import { log } from '../lib/utils.js';
import {
  markReadAndTyping as waMarkReadAndTyping,
  notifyHumanAgent as waNotifyHuman,
  sendReaction as waSendReaction,
  sendText as waSendText,
} from '../whatsapp/outgoing.js';
import { fetchInboundMedia as waFetchMedia, type DownloadedMedia } from '../whatsapp/media.js';
import {
  fetchTgMedia,
  tgNotifyHuman,
  tgSendText,
  tgSendTyping,
} from '../telegram/client.js';

/**
 * مُوجّه قنوات: نفس الوظائف عبر واتساب أو تيليجرام.
 *
 * التمييز بمفتاح الجلسة:
 *  - `97250...`         → واتساب
 *  - `tg:123456789`     → تيليجرام
 *
 * لو واتساب موقوف (WHATSAPP_ENABLED=false) فلا webhook ولا إرسال منه —
 * تيليجرام يخدم وحده.
 */

export const isTgKey = (key: string): boolean => key.startsWith('tg:');
const tgChatId = (key: string): string => key.slice(3);

/** واتساب معطّل فعليًا؟ (في وضع التجربة المحاكاة المحلية مسموحة دائمًا) */
const waDisabled = (): boolean => !config.whatsapp.ENABLED && !config.env.DEMO_MODE;

/** إرسال نص (يُقسَّم تلقائيًا حسب حد القناة) */
export async function sendOutbound(
  key: string,
  body: string,
  opts: { contextMessageId?: string } = {},
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  if (isTgKey(key)) {
    return tgSendText(tgChatId(key), body, { replyTo: opts.contextMessageId });
  }
  if (waDisabled()) {
    log.warn(`⏸ واتساب موقوف — تعذّر الإرسال إلى ${key}`);
    return { ok: false, error: 'whatsapp_disabled' };
  }
  return waSendText(key, body, { contextMessageId: opts.contextMessageId });
}

/** تفاعل إيموجي على رسالة العميل (واتساب فقط — لا مقابل له في تيليجرام) */
export async function reactToInbound(key: string, messageId: string, emoji: string): Promise<void> {
  if (isTgKey(key) || !emoji) return;
  if (waDisabled()) return;
  await waSendReaction(key, messageId, emoji);
}

/** تعليم الوارد كمقروء + مؤشر "يكتب…" (قبل المعالجة) */
export async function markInbound(key: string, messageId: string): Promise<void> {
  if (isTgKey(key)) {
    void tgSendTyping(tgChatId(key));
    return;
  }
  if (waDisabled()) return;
  await waMarkReadAndTyping(messageId);
}

/** تنزيل وسائط واردة حسب القناة */
export async function fetchChannelMedia(
  key: string,
  media: { id: string; mimeType: string; kind: 'image' | 'audio' | 'video' | 'document' },
): Promise<DownloadedMedia | null> {
  if (isTgKey(key)) return fetchTgMedia(media);
  return waFetchMedia(media);
}

/** تنبيه الموظف البشري عند التحويل/الليدات */
export async function notifyHuman(
  key: string,
  customerName: string,
  lastMessage: string,
  reason?: string,
): Promise<void> {
  if (isTgKey(key)) {
    await tgNotifyHuman(customerName, key, lastMessage, reason);
    return;
  }
  if (waDisabled()) {
    log.warn('⏸ واتساب موقوف — تنبيه الموظف يظهر في لوحة التحكم فقط.');
    return;
  }
  await waNotifyHuman(key, customerName, lastMessage, reason);
}
