import { config } from '../config.js';
import { log } from '../lib/utils.js';
import {
  markReadAndTyping as waMarkReadAndTyping,
  notifyHumanAgent as waNotifyHuman,
  sendButtons as waSendButtons,
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
import type { QuickReply } from '../agent/personality.js';

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

/** إرسال نص (يُقسَّم تلقائيًا حسب حد القناة) — مع أزرار اختيار اختيارية */
export async function sendOutbound(
  key: string,
  body: string,
  opts: { contextMessageId?: string; buttons?: QuickReply[] } = {},
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const buttons = (opts.buttons ?? []).slice(0, 3);
  if (isTgKey(key)) {
    return tgSendText(tgChatId(key), body, { replyTo: opts.contextMessageId, buttons });
  }
  if (waDisabled()) {
    log.warn(`⏸ واتساب موقوف — تعذّر الإرسال إلى ${key}`);
    return { ok: false, error: 'whatsapp_disabled' };
  }
  if (buttons.length >= 2) {
    const r = await waSendButtons(key, body, buttons.map((b) => ({ id: b.id, title: b.title })));
    if (r.ok) return r;
    log.warn('تعذّر إرسال الأزرار — إسقاط إلى نص عادي');
  }
  return waSendText(key, body, { contextMessageId: opts.contextMessageId });
}

/** تجديد مؤشر «يكتب…» أثناء الردود المتعددة */
export async function sendTyping(key: string): Promise<void> {
  if (isTgKey(key)) await tgSendTyping(tgChatId(key));
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

/** رقم واتساب المدير — كل طلب مؤكد يُحوَّل إليه */
export const MANAGER_WHATSAPP = '97059349809';
/** رقم/مرجع تيليجرام المدير */
export const MANAGER_TELEGRAM = '+972599891559';

/** تطبيع رقم هاتف لصيغة واتساب (أرقام فقط بدون + أو أصفار دولية) */
export function normalizeWaNumber(raw: string): string {
  let d = (raw ?? '').replace(/[^\d]/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  return d;
}

/** رقم واتساب المدير — المصدر الوحيد لتحويل الطلبات المؤكدة */
export function managerWhatsAppNumber(): string {
  return normalizeWaNumber(
    config.whatsapp.MANAGER_NUMBER || config.whatsapp.HUMAN_AGENT_ID || MANAGER_WHATSAPP,
  ) || MANAGER_WHATSAPP;
}

/** هل نملك اعتمادات كافية لإرسال واتساب للمدير (حتى لو قناة العملاء موقوفة)؟ */
function canSendManagerWhatsApp(): boolean {
  if (config.env.DEMO_MODE) return true;
  return Boolean(config.whatsapp.ACCESS_TOKEN && config.whatsapp.PHONE_NUMBER_ID);
}

/** تنبيه الموظف البشري عند التحويل/الليدات — واتساب +97059349809 وتيليجرام +972599891559 */
export async function notifyHuman(
  key: string,
  customerName: string,
  lastMessage: string,
  reason?: string,
): Promise<void> {
  const tgChatId = config.telegram.MANAGER_CHAT_ID || config.telegram.HUMAN_CHAT_ID;
  if (tgChatId && config.telegram.TOKEN) {
    await tgNotifyHuman(customerName, key, lastMessage, reason);
  }

  if (canSendManagerWhatsApp()) {
    await waNotifyHuman(key, customerName, lastMessage, reason);
  } else if (!tgChatId) {
    log.warn('⏸ لا اعتمادات واتساب ولا معرّف تيليجرام — تنبيه الموظف يظهر في لوحة التحكم فقط.');
  }
}

/** ذاكرة مؤقتة لمنع تكرار إرسال نفس الطلب للمدير خلال فترة وجيزة (دقيقتان) مع تتبع طول النص */
const recentlyNotifiedOrders = new Map<string, { time: number; noteLength: number }>();
const NOTIFY_DEDUP_WINDOW_MS = 2 * 60 * 1000;

/**
 * إرسال ملف طلب الإطلاق المؤكد لمدير المنصة.
 * يرسل الإشعار للمدير عبر كل القنوات المتاحة (تيليجرام + واتساب معًا).
 */
export async function notifyManager(note: string, orderRef?: string): Promise<boolean> {
  if (orderRef) {
    const lastSent = recentlyNotifiedOrders.get(orderRef);
    if (lastSent && Date.now() - lastSent.time < NOTIFY_DEDUP_WINDOW_MS) {
      // إذا كان الإشعار الجديد تفصيلياً (ملف كامل) والإشعار السابق كان مختصراً، نسمح بمروره
      const isMuchRicher = note.length > lastSent.noteLength + 80;
      if (!isMuchRicher) {
        log.info(`ℹ️ طلب الإطلاق ${orderRef} أُرسل للمدير قبل قليل — تخطي التكرار`);
        return true;
      }
    }
  }

  let delivered = false;
  const to = managerWhatsAppNumber();
  const headed = note.includes('+97059349809') || note.includes('97059349809')
    ? note
    : `📦 *طلب مؤكد — مُريح*\n📲 واتساب المدير: +970 593 498 09\n💬 تيليجرام المدير: +972 599 891 559\n\n${note}`;

  // 1) الإرسال عبر تيليجرام للمدير
  let tgChatId = config.telegram.MANAGER_CHAT_ID || config.telegram.HUMAN_CHAT_ID;
  if (!tgChatId || !/^\d+$/.test(tgChatId)) {
    // تيليجرام Bot API يتطلب chat_id رقمي؛ نستخدم معرّف المدير المؤكد
    tgChatId = '7687559523';
  }
  if (tgChatId && config.telegram.TOKEN) {
    try {
      log.ok(`🚀 إرسال طلب الإطلاق ${orderRef ?? ''} لمدير المنصة عبر تيليجرام (${tgChatId} — ${config.telegram.MANAGER_PHONE || '7687559523'})`);
      const r = await tgSendText(tgChatId, headed);
      if (r.ok) {
        delivered = true;
      } else {
        log.warn(`⚠️ تعذّر تسليم طلب الإطلاق عبر تيليجرام: ${r.error ?? '؟'}`);
      }
    } catch (err) {
      log.error(`فشل إرسال طلب الإطلاق للمدير على تيليجرام: ${(err as Error).message}`);
    }
  } else {
    log.warn('⚠️ إرسال تيليجرام للمدير معطّل — تأكد من ضبط TELEGRAM_MANAGER_CHAT_ID');
  }

  // 2) واتساب المدير — إجباري لكل طلب مؤكد على +97059349809
  // لا نربطه بـ WHATSAPP_ENABLED (قناة العملاء): التنبيه الإداري يُرسل ما دامت الاعتمادات موجودة.
  if (!canSendManagerWhatsApp()) {
    log.warn(`⏸ تعذّر واتساب للمدير ${to} — ناقص WHATSAPP_ACCESS_TOKEN / PHONE_NUMBER_ID (الطلب سجّل في اللوحة)`);
  } else {
    try {
      log.wa(`🚀 تحويل الطلب المؤكد ${orderRef ?? ''} إلى واتساب المدير +${to}`);
      const r = await waSendText(to, headed);
      if (r.ok) {
        delivered = true;
        log.ok(`✅ وصل الطلب ${orderRef ?? ''} إلى +${to}`);
      } else {
        log.warn(`⚠️ فشل إرسال الطلب المؤكد لواتساب المدير +${to}: ${r.error ?? '؟'}`);
      }
    } catch (err) {
      log.error(`خطأ أثناء إرسال إشعار واتساب للمدير +${to}: ${(err as Error).message}`);
    }
  }

  if (delivered && orderRef) {
    recentlyNotifiedOrders.set(orderRef, { time: Date.now(), noteLength: note.length });
    if (recentlyNotifiedOrders.size > 200) {
      const now = Date.now();
      for (const [k, v] of recentlyNotifiedOrders.entries()) {
        if (now - v.time > NOTIFY_DEDUP_WINDOW_MS) recentlyNotifiedOrders.delete(k);
      }
    }
  }

  return delivered;
}
