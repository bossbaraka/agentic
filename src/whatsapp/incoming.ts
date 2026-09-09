import { config } from '../config.js';
import type { NormalizedInbound, WebhookMessage, WebhookPayload, WebhookValue } from './types.js';

/**
 * تحليل حمولة الـ webhook وتوحيد شكلها.
 *
 * ⚠️ نقطة يقع فيها أغلب المبتدئين: البنية كلها مصفوفات متداخلة
 *    entry[] → changes[] → value.messages[]
 *    و Meta قد ترسل عدة رسائل في طلب واحد. لذلك نمرّ على الكل،
 *    ولا نكتفي بـ messages[0] أبدًا.
 */
export function parseWebhookPayload(payload: WebhookPayload): NormalizedInbound[] {
  const out: NormalizedInbound[] = [];
  if (!payload || !Array.isArray(payload.entry)) return out;

  for (const entry of payload.entry) {
    if (!Array.isArray(entry.changes)) continue;

    for (const change of entry.changes) {
      const value: WebhookValue | undefined = change.value;
      if (!value || !Array.isArray(value.messages)) continue;

      const phoneNumberId = value.metadata?.phone_number_id ?? config.whatsapp.PHONE_NUMBER_ID;

      // خريطة رقم العميل ← اسمه من ملفه الشخصي
      const nameByWa = new Map<string, string>();
      for (const c of value.contacts ?? []) {
        if (c?.wa_id) nameByWa.set(String(c.wa_id), c.profile?.name ?? '');
      }

      for (const msg of value.messages) {
        const normalized = normalizeMessage(msg, phoneNumberId, nameByWa.get(msg.from) ?? '');
        if (normalized) out.push(normalized);
      }
    }
  }

  return out;
}

/** توحيد رسالة واحدة */
export function normalizeMessage(
  msg: WebhookMessage,
  phoneNumberId: string,
  contactName: string,
): NormalizedInbound | null {
  if (!msg?.id || !msg?.from) return null;

  const base: NormalizedInbound = {
    channel: 'wa',
    waId: msg.id,
    from: String(msg.from),
    phoneNumberId,
    contactName: contactName || String(msg.from),
    type: msg.type ?? 'unknown',
    timestamp: Number(msg.timestamp ?? 0) * 1000 || Date.now(),
    forwarded: Boolean(msg.forward),
    body: '',
    raw: msg,
  };

  switch (msg.type) {
    case 'text': {
      base.body = msg.text?.body ?? '';
      break;
    }

    case 'image': {
      base.caption = msg.image?.caption;
      base.body = msg.image?.caption ?? '[العميل أرسل صورة]';
      if (msg.image) base.media = { id: msg.image.id, mimeType: msg.image.mime_type, kind: 'image' };
      break;
    }

    case 'video': {
      base.caption = msg.video?.caption;
      base.body = msg.video?.caption ?? '[العميل أرسل فيديو]';
      if (msg.video) base.media = { id: msg.video.id, mimeType: msg.video.mime_type, kind: 'video' };
      break;
    }

    // ملاحظة: واتساب يرسل التسجيل الصوتي كـ type:"audio" سواء كان voice أو audio
    case 'audio': {
      const ref = msg.audio ?? msg.voice;
      base.body = '[العميل أرسل رسالة صوتية]';
      if (ref) base.media = { id: ref.id, mimeType: ref.mime_type ?? 'audio/ogg', kind: 'audio' };
      break;
    }

    case 'document': {
      base.caption = msg.document?.caption;
      const filename = msg.document?.filename;
      base.body = msg.document?.caption
        ?? `[العميل أرسل مستندًا${filename ? `: ${filename}` : ''}]`;
      if (msg.document) {
        base.media = {
          id: msg.document.id,
          mimeType: msg.document.mime_type,
          kind: isPdf(msg.document.mime_type) ? 'document' : 'document',
        };
      }
      break;
    }

    case 'sticker': {
      base.body = '[العميل أرسل ملصقًا]';
      if (msg.sticker) base.media = { id: msg.sticker.id, mimeType: msg.sticker.mime_type, kind: 'image' };
      break;
    }

    case 'location': {
      const loc = msg.location;
      if (loc) {
        base.location = {
          latitude: Number(loc.latitude),
          longitude: Number(loc.longitude),
          name: loc.name,
          address: loc.address,
        };
        base.body =
          `[العميل أرسل موقعه: ${loc.name ?? ''}${loc.address ? ' - ' + loc.address : ''}` +
          ` (${Number(loc.latitude).toFixed(5)}, ${Number(loc.longitude).toFixed(5)})]`;
      } else {
        base.body = '[العميل أرسل موقعًا]';
      }
      break;
    }

    case 'contacts': {
      const c = msg.contacts?.[0];
      const name = c?.name?.formatted_name;
      const phone = c?.phones?.[0]?.phone;
      base.body = `[العميل أرسل بطاقة جهة اتصال${name ? `: ${name}` : ''}${phone ? ` (${phone})` : ''}]`;
      break;
    }

    case 'button': {
      base.body = msg.button?.text ?? '[العميل ضغط زرًا]';
      base.reply = { id: msg.button?.payload ?? '', title: msg.button?.text ?? '' };
      break;
    }

    case 'interactive': {
      const it = msg.interactive as any;
      if (it?.type === 'button_reply') {
        base.body = it.button_reply?.title ?? '[العميل اختار زرًا]';
        base.reply = { id: it.button_reply?.id ?? '', title: it.button_reply?.title ?? '' };
      } else if (it?.type === 'list_reply') {
        base.body = it.list_reply?.title ?? '[العميل اختار من قائمة]';
        base.reply = { id: it.list_reply?.id ?? '', title: it.list_reply?.title ?? '' };
      } else {
        base.body = `[العميل تفاعل مع رسالة: ${it?.type ?? 'غير معروف'}]`;
      }
      break;
    }

    case 'reaction': {
      // تفاعل إيموجي — لا يحتاج ردًا
      base.reaction = {
        messageId: msg.reaction?.message_id ?? '',
        emoji: msg.reaction?.emoji ?? '',
      };
      base.body = `[العميل تفاعل بالإيموجي ${base.reaction.emoji || '(أزال التفاعل)'}]`;
      break;
    }

    case 'order': {
      base.body = `[العميل أرسل طلبًا من الكتالوج${msg.order?.text ? ': ' + msg.order.text : ''}]`;
      break;
    }

    case 'unsupported':
    default: {
      base.type = 'unsupported';
      base.body = `[رسالة من نوع غير مدعوم: ${msg.type ?? 'unknown'}${msg.unsupported?.type ? ` / ${msg.unsupported.type}` : ''}]`;
      break;
    }
  }

  return base;
}

function isPdf(mime: string): boolean {
  return mime?.toLowerCase().includes('pdf');
}

/** أنواع لا نردّ عليها (تفاعل إيموجي، حذف رسالة) */
export function shouldSkipReply(msg: NormalizedInbound): { skip: boolean; reason?: string } {
  if (msg.type === 'reaction') return { skip: true, reason: 'تفاعل إيموجي' };
  if (msg.type === 'unsupported') return { skip: false }; // نرد برسالة لطيفة
  if (!msg.body || !msg.body.trim()) return { skip: true, reason: 'رسالة فارغة' };
  return { skip: false };
}

/** استخراج حالات التسليم (delivered/read/failed) لأغراض المراقبة */
export function parseStatuses(payload: WebhookPayload) {
  const statuses: { id: string; status: string; to: string; error?: string; category?: string }[] = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      for (const s of change.value?.statuses ?? []) {
        statuses.push({
          id: s.id,
          status: s.status,
          to: s.recipient_id,
          category: s.pricing?.category,
          error: s.errors?.map((e) => `${e.code}: ${e.title}`).join(' | '),
        });
      }
      for (const e of change.value?.errors ?? []) {
        statuses.push({ id: '', status: 'error', to: '', error: `${e.code}: ${e.title} ${e.message ?? ''}` });
      }
    }
  }
  return statuses;
}
