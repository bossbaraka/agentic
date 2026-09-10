import type { NormalizedInbound } from '../whatsapp/types.js';

/**
 * تحويل تحديثات Telegram إلى نفس الشكل الموحّد الذي يعالجه المنسّق.
 *
 * شكل التحديث (message):
 * {
 *   update_id: 123,
 *   message: {
 *     message_id: 1,
 *     date: 1700000000,
 *     chat: { id: 987654321, first_name: 'يوسف', last_name: 'النجار', username: 'yusuf' },
 *     from: { id, first_name, last_name, username, is_bot },
 *     text: '...',            // أو photo[] / audio / voice / video / document / location / contact / sticker
 *     caption: '...',
 *     reply_to_message: { message_id, text }
 *   }
 * }
 */
export function parseTelegramUpdate(u: any): NormalizedInbound | null {
  // ضغط زر تفاعلي
  if (u?.callback_query) {
    const cq = u.callback_query;
    const chat = cq.message?.chat ?? {};
    const from = cq.from ?? {};
    const chatId = String(chat.id ?? from.id ?? '');
    if (!chatId) return null;
    const data = String(cq.data ?? '');
    let title = data;
    for (const row of cq.message?.reply_markup?.inline_keyboard ?? []) {
      for (const b of row ?? []) {
        if (String(b.callback_data) === data) title = String(b.text ?? data);
      }
    }
    const usernameRaw = from.username ? String(from.username).trim() : '';
    const telegramUsername = usernameRaw ? (usernameRaw.startsWith('@') ? usernameRaw : `@${usernameRaw}`) : undefined;
    const fullName = [from.first_name, from.last_name].filter(Boolean).join(' ');
    const contactName = fullName
      ? (telegramUsername ? `${fullName} (${telegramUsername})` : fullName)
      : (telegramUsername || `TG-${chatId}`);
    return {
      channel: 'tg',
      waId: `tgcb${u.update_id ?? cq.id ?? Date.now()}`,
      from: `tg:${chatId}`,
      phoneNumberId: 'telegram',
      contactName,
      telegramUsername,
      type: 'interactive',
      timestamp: Date.now(),
      forwarded: false,
      body: title,
      reply: { id: data, title },
      raw: cq as Record<string, unknown>,
    };
  }

  const msg = u?.message ?? u?.edited_message;
  const chat = msg?.chat;
  if (!msg || !chat) return null;

  const from = msg.from ?? {};
  const chatId = String(chat.id);
  const usernameRaw = from.username ? String(from.username).trim() : '';
  const telegramUsername = usernameRaw ? (usernameRaw.startsWith('@') ? usernameRaw : `@${usernameRaw}`) : undefined;
  const fullName = [from.first_name, from.last_name].filter(Boolean).join(' ');
  const contactName = fullName
    ? (telegramUsername ? `${fullName} (${telegramUsername})` : fullName)
    : (telegramUsername || `TG-${chatId}`);

  const base: NormalizedInbound = {
    channel: 'tg',
    waId: `tg${u.update_id ?? msg.message_id ?? Date.now()}`,
    from: `tg:${chatId}`,
    phoneNumberId: 'telegram',
    contactName,
    telegramUsername,
    type: 'text',
    timestamp: (typeof msg.date === 'number' ? msg.date : 0) * 1000 || Date.now(),
    forwarded: Boolean(msg.forward_from ?? msg.forward_origin),
    body: '',
    raw: msg as Record<string, unknown>,
  };

  if (typeof msg.text === 'string' && msg.text.trim()) {
    base.type = 'text';
    base.body = msg.text;
  } else if (typeof msg.caption === 'string' && msg.caption.trim()) {
    base.caption = msg.caption;
    base.body = msg.caption;
  } else if (Array.isArray(msg.photo) && msg.photo.length) {
    const p = msg.photo[msg.photo.length - 1]; // أكبر حجم
    base.type = 'image';
    base.body = '[العميل أرسل صورة]';
    base.media = { id: String(p.file_id), mimeType: 'image/jpeg', kind: 'image' };
  } else if (msg.audio) {
    base.type = 'audio';
    base.body = '[العميل أرسل ملف صوتي]';
    base.media = { id: String(msg.audio.file_id), mimeType: msg.audio.mime_type ?? 'audio/mpeg', kind: 'audio' };
  } else if (msg.voice) {
    base.type = 'audio';
    base.body = '[العميل أرسل رسالة صوتية]';
    base.media = { id: String(msg.voice.file_id), mimeType: 'audio/ogg', kind: 'audio' };
  } else if (msg.video) {
    base.type = 'video';
    base.body = msg.video.caption ?? '[العميل أرسل فيديو]';
    base.media = { id: String(msg.video.file_id), mimeType: msg.video.mime_type ?? 'video/mp4', kind: 'video' };
  } else if (msg.document) {
    base.type = 'document';
    base.body = msg.document.file_name ?? '[العميل أرسل ملفًا]';
    base.media = {
      id: String(msg.document.file_id),
      mimeType: msg.document.mime_type ?? 'application/octet-stream',
      kind: 'document',
    };
  } else if (msg.location) {
    base.type = 'location';
    base.body = '[العميل أرسل موقعه]';
    base.location = {
      latitude: msg.location.latitude,
      longitude: msg.location.longitude,
      address: msg.location.label ?? msg.location.name,
    };
  } else if (msg.contact) {
    base.type = 'contact';
    base.body = `[بطاقة جهة اتصال: ${msg.contact.first_name ?? ''} ${msg.contact.last_name ?? ''} ${msg.contact.phone_number ?? ''}]`.trim();
  } else if (msg.sticker) {
    base.type = 'sticker';
    base.body = '[ملصق Sticker]';
  } else {
    return null; // نوع غير مدعوم
  }

  if (msg.reply_to_message?.message_id) {
    base.reply = {
      id: String(msg.reply_to_message.message_id),
      title: typeof msg.reply_to_message.text === 'string' ? msg.reply_to_message.text : '',
    };
  }

  return base;
}
