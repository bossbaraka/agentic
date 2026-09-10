import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log, sleep, splitText, uid } from '../lib/utils.js';
import type { MediaPart } from '../types.js';

/**
 * عميل Telegram Bot API — نفس نمط WhatsApp:
 *  - في وضع التجربة (DEMO_MODE) لا نتصل بـ Telegram إطلاقًا — نطبع في الطرفية
 *  - استطلاع دوري (long polling) افتراضيًا: لا يحتاج رابطًا عامًا
 *  - أو webhook إذا ضبطت TELEGRAM_WEBHOOK_URL
 */

const API = () => `https://api.telegram.org/bot${config.telegram.TOKEN}`;

/** هل تيليجرام مفعّل (يوجد توكن)؟ */
export function telegramEnabled(): boolean {
  return Boolean(config.telegram.TOKEN);
}

/** هل وضع الاستطلاع الدوري (بدل webhook)؟ */
export function telegramPollingMode(): boolean {
  return !config.telegram.WEBHOOK_URL;
}

// ─────────────────────── نداء API خام ───────────────────────

async function tgCall<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (config.env.DEMO_MODE) {
    // محاكاة نجاح في وضع التجربة (بدون اتصال خارجي)
    return { demo: true, message_id: `tgdemo${Date.now()}` } as unknown as T;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.telegram.TIMEOUT_MS);

  try {
    const res = await fetch(`${API()}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: controller.signal,
    });

    const json: any = await res.json().catch(() => null);
    if (!json?.ok) {
      throw new Error(`Telegram ${method} → ${json?.description ?? res.status}`);
    }
    return json.result as T;
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────── إرسال ───────────────────────

/**
 * إرسال نص (يُقسَّم تلقائيًا على حد تيليجرام).
 * نسعى لصيغة Markdown (تدعم *عريض* مثل واتساب) — وإن فشل التحويل نرسل نصًا سالبًا.
 */
export async function tgSendText(
  chatId: string,
  body: string,
  opts: { replyTo?: string; quiet?: boolean; buttons?: { id: string; title: string }[] } = {},
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const keyboard = (opts.buttons?.length ?? 0) >= 2
    ? {
        reply_markup: {
          inline_keyboard: [
            opts.buttons!.slice(0, 3).map((b) => ({
              text: b.title.slice(0, 40),
              callback_data: (b.id || b.title).slice(0, 64),
            })),
          ],
        },
      }
    : {};

  if (config.env.DEMO_MODE) {
    if (!opts.quiet) {
      const extra = opts.buttons?.length ? ` | أزرار: ${opts.buttons.map((b) => b.title).join(' · ')}` : '';
      log.wa(`🟢 تيليجرام [تجربة] → ${chatId} | نص: ${body.slice(0, 300)}${extra}`);
    }
    return { ok: true, messageId: `tgdemo${Date.now()}` };
  }

  const parts = splitText(body, config.telegram.MAX_SEGMENT_CHARS);
  let lastId: string | undefined;
  let allOk = true;

  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    const extra = {
      ...(i === 0 && opts.replyTo ? { reply_to_message_id: Number(opts.replyTo) || opts.replyTo } : {}),
      ...(isLast ? keyboard : {}),
    };
    try {
      const msg = await tgCall<any>('sendMessage', {
        chat_id: chatId,
        text: parts[i],
        parse_mode: 'Markdown',
        ...extra,
      });
      lastId = String(msg.message_id);
    } catch (err) {
      const msgText = (err as Error).message ?? '';
      if (/parse|entities/i.test(msgText)) {
        try {
          const msg = await tgCall<any>('sendMessage', {
            chat_id: chatId,
            text: parts[i],
            ...extra,
          });
          lastId = String(msg.message_id);
        } catch (err2) {
          allOk = false;
          log.error(`فشل إرسال تيليجرام إلى ${chatId}: ${(err2 as Error).message}`);
        }
      } else {
        allOk = false;
        log.error(`فشل إرسال تيليجرام إلى ${chatId}: ${msgText}`);
      }
    }
    if (i < parts.length - 1) await sleep(300);
  }

  return { ok: allOk, messageId: lastId, error: allOk ? undefined : 'telegram_send_failed' };
}

/** إيقاف دائرة التحميل على الزر بعد الضغط */
export async function tgAnswerCallback(callbackId: string, text?: string): Promise<void> {
  if (config.env.DEMO_MODE || !callbackId) return;
  try {
    await tgCall('answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text } : {}) });
  } catch {
    /* غير حرج */
  }
}

/** مؤشر "يكتب…" (فعّال 5 ثوانٍ في تيليجرام) */
export async function tgSendTyping(chatId: string): Promise<void> {
  if (config.env.DEMO_MODE || !config.telegram.TOKEN) return;
  try {
    await tgCall('sendChatAction', { chat_id: chatId, action: 'typing' });
  } catch {
    /* غير حرج */
  }
}

// ─────────────────────── وسائط ───────────────────────

const EXT_MIME: Record<string, string> = {
  jpeg: 'image/jpeg', jpg: 'image/jpeg', webp: 'image/webp', png: 'image/png',
  ogg: 'audio/ogg', opus: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4',
  mp4: 'video/mp4', mov: 'video/quicktime', pdf: 'application/pdf',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export interface DownloadedTgMedia extends MediaPart {
  localPath?: string;
}

/** تنزيل وسائط واردة (file_id من Telegram) → base64 + حفظ اختياري */
export async function fetchTgMedia(
  media: { id: string; mimeType: string; kind: MediaPart['kind'] },
): Promise<DownloadedTgMedia | null> {
  if (config.env.DEMO_MODE) {
    return {
      kind: media.kind,
      mimeType: media.mimeType,
      data: '',
      bytes: 0,
      note: '[وضع التجربة: الوسائط غير متاحة — سيتم وصفها نصيًا فقط]',
    };
  }
  if (!config.telegram.TOKEN) {
    return { kind: media.kind, mimeType: media.mimeType, data: '', bytes: 0, note: '[لا يوجد توكن تيليجرام]' };
  }

  try {
    const file = await tgCall<any>('getFile', { file_id: media.id });
    if (!file?.file_path) throw new Error('getFile لم يرجع مسارًا');
    if (file.file_size && file.file_size > config.paths.MAX_MEDIA_BYTES) {
      throw new Error(`الملف كبير (${Math.round(file.file_size / 1024 / 1024)} MB)`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.telegram.TIMEOUT_MS);
    let buffer: Buffer;
    try {
      const res = await fetch(`${API()}/file/${file.file_path}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`Media download ${res.status}`);
      buffer = Buffer.from(await res.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }

    const ext = (file.file_path.split('.').pop() ?? '').toLowerCase();
    const effectiveMime = EXT_MIME[ext] ?? media.mimeType;

    let localPath: string | undefined;
    if (config.paths.SAVE_MEDIA) {
      const dot = file.file_path.includes('.') ? '.' : '';
      localPath = path.join(config.paths.MEDIA_DIR, `${Date.now()}_${uid('f')}${dot}${ext}`);
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, buffer);
    }

    log.info(`📎 وسائط تيليجرام ${media.kind} (${(buffer.byteLength / 1024).toFixed(0)} KB, ${effectiveMime})`);

    return {
      kind: media.kind,
      mimeType: effectiveMime,
      data: buffer.toString('base64'),
      bytes: buffer.byteLength,
      localPath,
    };
  } catch (err) {
    log.warn(`تعذّر تنزيل وسائط تيليجرام: ${(err as Error).message}`);
    return { kind: media.kind, mimeType: media.mimeType, data: '', bytes: 0, note: `[تعذّر تنزيل الوسائط: ${(err as Error).message}]` };
  }
}

// ─────────────────────── تنبيه الموظف ───────────────────────

/** تنبيه المدير/الموظف في تيليجرام (لو ضبط TELEGRAM_HUMAN_CHAT_ID) */
export async function tgNotifyHuman(customerName: string, chatKey: string, lastMessage: string, reason?: string): Promise<void> {
  const to = config.telegram.MANAGER_CHAT_ID || config.telegram.HUMAN_CHAT_ID;
  if (!to) {
    log.warn(`🚨 تنبيه تيليجرام: TELEGRAM_MANAGER_CHAT_ID / TELEGRAM_HUMAN_CHAT_ID غير مضبوط — يظهر التنبيه في لوحة التحكم فقط.`);
    return;
  }

  const text =
    `🔔 *تحويل محادثة لموظف بشري (تيليجرام)*\n` +
    `العميل: ${customerName} (${chatKey})\n` +
    (reason ? `السبب: ${reason}\n` : '') +
    `آخر رسالة: ${lastMessage.slice(0, 500)}\n\n` +
    `الرد: افتح المحادثة في تطبيقك أو عبر لوحة التحكم.`;

  await tgSendText(to, text, { quiet: true });
}

// ─────────────────────── الاستطلاع الدوري (long polling) ───────────────────────

let pollingStopped = false;

export async function startTelegramPolling(onUpdate: (u: any) => void): Promise<void> {
  if (!config.telegram.TOKEN || config.env.DEMO_MODE) {
    if (config.telegram.TOKEN) log.info('🟢 تيليجرام: وضع التجربة — الاستطلاع الدوري غير مفعّل (شغّل DEMO_MODE=false للإرسال الحقيقي).');
    return;
  }

  pollingStopped = false;
  let offset = 0;
  log.ok('🟢 تيليجرام: وضع الاستطلاع الدوري (getUpdates) — بدون رابط عام');

  const loop = async () => {
    while (!pollingStopped) {
      try {
        const updates = await tgCall<any[]>('getUpdates', {
          offset,
          timeout: 30,
          allowed_updates: ['message', 'callback_query', 'edited_message'],
        });
        for (const u of updates ?? []) {
          offset = Math.max(offset, (u.update_id ?? 0) + 1);
          try {
            onUpdate(u);
          } catch (err) {
            log.error(`خطأ في معالجة تحديث تيليجرام: ${(err as Error).stack ?? err}`);
          }
        }
      } catch (err) {
        if (pollingStopped) break;
        log.warn(`استطلاع تيليجرام: ${(err as Error).message} — إعادة بعد 5 ثوانٍ`);
        await sleep(5000);
      }
    }
  };

  void loop();
}

export function stopTelegramPolling(): void {
  pollingStopped = true;
}

// ─────────────────────── webhook ───────────────────────

export async function setTelegramWebhook(publicUrl: string, secret: string): Promise<void> {
  await tgCall('setWebhook', { url: publicUrl, secret_token: secret, allowed_updates: ['message', 'callback_query'] });
  log.ok(`🟢 تيليجرام: webhook مضبوط على ${publicUrl}`);
}

export async function deleteTelegramWebhook(): Promise<void> {
  try {
    await tgCall('deleteWebhook', { drop_pending_updates: false });
  } catch {
    /* غير حرج */
  }
}

/** تحقق من توقيع webhook (secret_token) */
export function verifyTelegramSecret(token: string | undefined): boolean {
  if (!config.telegram.WEBHOOK_SECRET) return true; // بدون سر → نقبل (لا يوجد webhook فعلي عادةً)
  return token === config.telegram.WEBHOOK_SECRET;
}
