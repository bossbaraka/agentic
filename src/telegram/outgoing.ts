import { config } from '../config.js';
import { log, sleep, splitText } from '../lib/utils.js';
import type { MediaPart } from '../types.js';
import type { TelegramFile } from './types.js';

const TELEGRAM_API_URL = () => `https://api.telegram.org/bot${config.telegram.BOT_TOKEN}`;

/** إرسال طلب لـ Telegram Bot API */
async function telegramCall<T = any>(method: string, body: Record<string, unknown>): Promise<{ ok: boolean; result?: T; description?: string }> {
  if (config.env.DEMO_MODE || !config.telegram.BOT_TOKEN) {
    log.info(`[Telegram DEMO] ${method} -> ${JSON.stringify(body)}`);
    return { ok: true, result: { demo: true } as any };
  }

  const url = `${TELEGRAM_API_URL()}/${method}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.gemini.TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const data = (await res.json()) as any;
    if (!res.ok || !data.ok) {
      log.error(`Telegram API Error (${method}): ${data.description || res.statusText}`);
      return { ok: false, description: data.description };
    }
    return { ok: true, result: data.result };
  } catch (err) {
    log.error(`Telegram Fetch Exception (${method}): ${(err as Error).message}`);
    return { ok: false, description: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/** استخلاص chatId النقية من المفتاح البادئ بـ tg: */
export function cleanTgChatId(to: string): string {
  return to.startsWith('tg:') ? to.slice(3) : to;
}

/** إظهار مؤشر الكتابة في تلغرام */
export async function sendTelegramTyping(to: string): Promise<void> {
  const chatId = cleanTgChatId(to);
  await telegramCall('sendChatAction', { chat_id: chatId, action: 'typing' });
}

/** إرسال نص عادي إلى تلغرام */
export async function sendTelegramText(
  to: string,
  text: string,
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const chatId = cleanTgChatId(to);
  const res = await telegramCall('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML', // تدعم وسم <b> <i> <code>
  });

  if (!res.ok) {
    // حاول مرة أخرى بدون HTML لو فشل التنسيق
    const retry = await telegramCall('sendMessage', {
      chat_id: chatId,
      text,
    });
    return { ok: retry.ok, messageId: retry.result?.message_id?.toString(), error: retry.description };
  }

  return { ok: true, messageId: res.result?.message_id?.toString() };
}

/** إرسال نص طويل مقسّم إلى تلغرام */
export async function sendTelegramLongText(
  to: string,
  text: string,
): Promise<{ ok: boolean; messageIds: string[]; parts: number }> {
  const parts = splitText(text, 3800); // Telegram limit is 4096
  const ids: string[] = [];
  let ok = true;

  for (let i = 0; i < parts.length; i++) {
    const r = await sendTelegramText(to, parts[i]);
    if (!r.ok) ok = false;
    if (r.messageId) ids.push(r.messageId);
    if (i < parts.length - 1) await sleep(300);
  }

  return { ok, messageIds: ids, parts: parts.length };
}

/** تنزيل وسائط من خوادم تلغرام وتوفيرها كـ base64 لـ Gemini */
export async function fetchTelegramMedia(
  fileId: string,
  kind: MediaPart['kind'],
  mimeType: string,
): Promise<MediaPart | null> {
  if (config.env.DEMO_MODE || !config.telegram.BOT_TOKEN) {
    return null;
  }

  try {
    const fileRes = await telegramCall<TelegramFile>('getFile', { file_id: fileId });
    if (!fileRes.ok || !fileRes.result?.file_path) {
      log.warn(`تعذر الحصول على مسار ملف تلغرام: ${fileId}`);
      return null;
    }

    const downloadUrl = `https://api.telegram.org/file/bot${config.telegram.BOT_TOKEN}/${fileRes.result.file_path}`;
    const res = await fetch(downloadUrl);
    if (!res.ok) {
      log.warn(`فشل تنزيل ملف تلغرام: ${res.statusText}`);
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > config.paths.MAX_MEDIA_BYTES) {
      log.warn(`وسائط تلغرام كبيرة جدًا (${buffer.length} بايت)`);
      return null;
    }

    return {
      kind,
      mimeType,
      data: buffer.toString('base64'),
      bytes: buffer.length,
    };
  } catch (err) {
    log.error(`خطأ أثناء جلب وسائط تلغرام: ${(err as Error).message}`);
    return null;
  }
}
